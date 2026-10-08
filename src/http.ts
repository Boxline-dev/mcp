/**
 * The MCP server over HTTP (`boxline-mcp --http`). Stateless: every request builds its own server around the caller's
 * API key (`Authorization: Bearer <API key>`), so any replica can serve any request and a restart loses nothing. There is
 * no protocol session and no default session: a conversation carries the sessionId that `session_create` returned.
 *
 * Plain `node:http` runs our checks first (host, origin, Bearer token, body size, `GET /healthz`), then hands `/mcp` to
 * the MCP SDK's handler, which serves 2026-07-28 clients and, statelessly, the 2025-era ones.
 *
 * The Bearer token is a Boxline API key (`bxl_…`) or an OAuth access token (`bxo_…`, what ChatGPT and Claude hold after a person
 * clicked "Connect"). With `resource` and `authServer` set the server also publishes OAuth protected resource metadata (RFC 9728)
 * and answers a missing or refused token with the `WWW-Authenticate` challenge those clients follow to sign in. Every token is
 * checked against the API once a minute (one `GET /v1/auth/me`, cached by its hash), so an expired token gets a 401 here and the
 * client refreshes it, instead of a tool error.
 */
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Boxline, BoxlineError } from "@boxline/sdk";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createServer, type ToolSetting } from "./server.js";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Requests served at once; more get 503, so a flood cannot run the container out of memory. */
export const MAX_IN_FLIGHT = 32;
/** Requests one bearer token may have running at once; more get 503, so one caller cannot hold every slot with long calls. */
export const MAX_IN_FLIGHT_PER_TOKEN = 8;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export interface HttpOptions {
  /** The Boxline API to call (BOXLINE_API_URL); the SDK's default when unset. */
  apiUrl?: string;
  tools?: ToolSetting;
  /** Host names the server answers to (MCP_ALLOWED_HOSTS), without ports; loopback is always allowed; `*` turns the host and origin checks off. */
  allowedHosts?: string[];
  maxBodyBytes?: number;
  /** Requests served at once (MCP_MAX_IN_FLIGHT); more get 503. */
  maxInFlight?: number;
  /** Requests one token may have running at once (MCP_MAX_IN_FLIGHT_PER_TOKEN, default 8); more get 503. */
  maxInFlightPerToken?: number;
  /** SSE keep-alive interval in ms (default 15 000): bytes keep flowing while a long tool call runs, so a load balancer's idle timeout does not cut it. */
  keepAliveMs?: number;
  /** Where errors are reported (message only; never a token or a request). Defaults to stderr. */
  log?: (message: string) => void;
  /** This server's public MCP URL (MCP_RESOURCE, `https://mcp.example.com/mcp`) and the authorization server's issuer (MCP_AUTH_SERVER). OAuth discovery is on only with both. */
  resource?: string;
  authServer?: string;
  /** Where people read about this server (`resource_documentation` in the metadata). */
  resourceDocumentation?: string;
  /** What `GET /.well-known/openai-apps-challenge` answers (MCP_OPENAI_CHALLENGE); 404 when unset. */
  openaiChallenge?: string;
  /** How long a token's check against the API is remembered, in seconds (MCP_TOKEN_CACHE_SECONDS, default 60; 0 checks every request). */
  tokenCacheSeconds?: number;
}

/** The scopes the authorization server offers (docs: OAuth for MCP clients). */
export const OAUTH_SCOPES = ["boxline", "openid", "email", "offline_access"];
/** What a Boxline OAuth access token looks like: the hosted server gives these the `directory` tools. */
const OAUTH_TOKEN_PREFIX = "bxo_";
const DEFAULT_DOCUMENTATION = "https://docs.boxline.dev/mcp";
const TOKEN_CHECK_TIMEOUT_MS = 5000;
const TOKEN_CACHE_MAX = 10_000;

/**
 * The HTTP settings from the environment: MCP_PORT, MCP_HOST, MCP_ALLOWED_HOSTS, MCP_TOOLS, MCP_MAX_IN_FLIGHT,
 * MCP_MAX_IN_FLIGHT_PER_TOKEN, BOXLINE_API_URL, MCP_RESOURCE, MCP_AUTH_SERVER, MCP_OPENAI_CHALLENGE, MCP_TOKEN_CACHE_SECONDS. Throws on a bad value.
 */
export function httpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions & { port: number; host: string } {
  const port = env.MCP_PORT === undefined || env.MCP_PORT === "" ? 8081 : Number(env.MCP_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`MCP_PORT must be a port number, got "${env.MCP_PORT}"`);
  const tools = env.MCP_TOOLS === undefined || env.MCP_TOOLS === "" ? "full" : env.MCP_TOOLS;
  if (tools !== "full" && tools !== "directory") throw new Error(`MCP_TOOLS must be "full" or "directory", got "${env.MCP_TOOLS}"`);
  const url = (name: string): string | undefined => {
    const v = env[name]?.trim();
    if (!v) return undefined;
    try {
      const u = new URL(v);
      if (!/^https?:$/.test(u.protocol) || u.hash) throw new Error("not http(s) or has a fragment");
    } catch {
      throw new Error(`${name} must be an http(s) URL without a fragment, got "${v}"`);
    }
    return v;
  };
  const resource = url("MCP_RESOURCE");
  const authServer = url("MCP_AUTH_SERVER");
  if (Boolean(resource) !== Boolean(authServer)) throw new Error("MCP_RESOURCE and MCP_AUTH_SERVER go together: set both (OAuth sign-in) or neither");
  const cache = env.MCP_TOKEN_CACHE_SECONDS === undefined || env.MCP_TOKEN_CACHE_SECONDS === "" ? undefined : Number(env.MCP_TOKEN_CACHE_SECONDS);
  if (cache !== undefined && (!Number.isFinite(cache) || cache < 0 || cache > 3600)) throw new Error(`MCP_TOKEN_CACHE_SECONDS must be 0 to 3600, got "${env.MCP_TOKEN_CACHE_SECONDS}"`);
  const perToken = env.MCP_MAX_IN_FLIGHT_PER_TOKEN === undefined || env.MCP_MAX_IN_FLIGHT_PER_TOKEN === "" ? undefined : Number(env.MCP_MAX_IN_FLIGHT_PER_TOKEN);
  if (perToken !== undefined && (!Number.isInteger(perToken) || perToken < 1)) throw new Error(`MCP_MAX_IN_FLIGHT_PER_TOKEN must be a whole number, 1 or more, got "${env.MCP_MAX_IN_FLIGHT_PER_TOKEN}"`);
  return {
    port,
    host: env.MCP_HOST || "0.0.0.0",
    resource,
    authServer,
    openaiChallenge: env.MCP_OPENAI_CHALLENGE?.trim() || undefined,
    tokenCacheSeconds: cache,
    apiUrl: env.BOXLINE_API_URL || undefined,
    tools,
    maxInFlight: env.MCP_MAX_IN_FLIGHT ? Number(env.MCP_MAX_IN_FLIGHT) : undefined,
    maxInFlightPerToken: perToken,
    allowedHosts: (env.MCP_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

/** Lower-cased host name of a Host header or an allowed-host entry: no port, IPv6 keeps its brackets. */
function hostName(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("[")) return v.slice(0, v.indexOf("]") + 1);
  return v.replace(/:\d*$/, "");
}

/** Whether a Host header names one of the allowed hosts (port-agnostic; loopback always). */
export function hostAllowed(header: string | undefined, allowedHosts: string[]): boolean {
  if (allowedHosts.includes("*")) return true;
  if (!header) return false;
  return [...LOOPBACK, ...allowedHosts.map(hostName)].includes(hostName(header));
}

/** A browser's Origin must be one of the allowed hosts too (any scheme or port); no Origin (every non-browser client) passes. */
export function originAllowed(origin: string | undefined, allowedHosts: string[]): boolean {
  if (origin === undefined) return true;
  if (allowedHosts.includes("*")) return true;
  try {
    return [...LOOPBACK, ...allowedHosts.map(hostName)].includes(hostName(new URL(origin).host));
  } catch {
    return false; // "null" or garbage
  }
}

/** The token of `Authorization: Bearer <token>`, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer +(\S+)$/i.exec(header ?? "");
  return m?.[1];
}

function reply(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}

/** A JSON-RPC error body, as the MCP SDK answers its own rejections. `close` also ends the connection (the body was not read). */
function rpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export interface HttpHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Stops what the SDK handler still has in flight. */
  close(): Promise<void>;
}

/** The client's address as the load balancer saw it: the last X-Forwarded-For entry (the one it appended), else the peer. */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").pop()?.trim();
  return last || req.socket?.remoteAddress || "-";
}

/**
 * Asks the API whether a token is good: one `GET /v1/auth/me` with it, the answer remembered by the token's hash (never the
 * token) for `ttlMs`, refused and accepted alike, so a made-up token costs one API call a minute however often it is tried.
 * Only a 401 refuses a token; any other answer (the API down, a 5xx, a route it does not have) says nothing about it and is not
 * remembered. A token revoked at the API stops working here within `ttlMs`.
 */
class TokenChecks {
  private readonly seen = new Map<string, { ok: boolean; until: number }>();
  private readonly asking = new Map<string, Promise<boolean | null>>();

  constructor(
    private readonly apiUrl: string | undefined,
    private readonly ttlMs: number,
  ) {}

  /** true: accepted; false: the API answered 401; null: could not tell. */
  async check(token: string): Promise<boolean | null> {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.seen.get(key);
    if (hit && hit.until > Date.now()) return hit.ok;
    let pending = this.asking.get(key);
    if (!pending) {
      pending = this.ask(token)
        .then((ok) => {
          if (ok !== null && this.ttlMs > 0) this.remember(key, ok);
          return ok;
        })
        .finally(() => this.asking.delete(key));
      this.asking.set(key, pending);
    }
    return pending;
  }

  private remember(key: string, ok: boolean) {
    const now = Date.now();
    if (this.seen.size >= TOKEN_CACHE_MAX) {
      for (const [k, v] of this.seen) if (v.until <= now) this.seen.delete(k);
      // Still full of live answers (a flood of distinct tokens): drop the oldest, the Map keeps insertion order.
      while (this.seen.size >= TOKEN_CACHE_MAX) this.seen.delete(this.seen.keys().next().value as string);
    }
    this.seen.set(key, { ok, until: now + this.ttlMs });
  }

  private async ask(token: string): Promise<boolean | null> {
    try {
      await new Boxline({ apiKey: token, baseUrl: this.apiUrl, maxRetries: 0, timeoutMs: TOKEN_CHECK_TIMEOUT_MS }).me();
      return true;
    } catch (err) {
      return err instanceof BoxlineError && err.status === 401 ? false : null;
    }
  }
}

export function createHttpHandler(opts: HttpOptions = {}): HttpHandler {
  const allowedHosts = opts.allowedHosts ?? [];
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  let inFlight = 0;
  // Requests running per token, counted by the SHA-256 of the token (never the token itself); an entry goes when its count reaches 0.
  const maxPerToken = opts.maxInFlightPerToken ?? MAX_IN_FLIGHT_PER_TOKEN;
  const perToken = new Map<string, number>();
  const log = opts.log ?? ((m: string) => process.stderr.write(`boxline-mcp: ${m}\n`));
  const onerror = (err: Error) => log(`error: ${err.message}`);
  const checks = new TokenChecks(opts.apiUrl, (opts.tokenCacheSeconds ?? 60) * 1000);

  // OAuth discovery (RFC 9728): on only with the server's own URL and the authorization server. The metadata lives at the root
  // path and at the resource's path suffix (`/.well-known/oauth-protected-resource/mcp`); the 401 challenge names the second.
  const oauth = opts.resource && opts.authServer ? { resource: opts.resource, authServer: opts.authServer } : null;
  const resourceUrl = oauth ? new URL(oauth.resource) : null;
  const suffix = resourceUrl && resourceUrl.pathname !== "/" ? resourceUrl.pathname.replace(/\/$/, "") : "";
  const metadataPath = `/.well-known/oauth-protected-resource${suffix}`;
  const metadataPaths = new Set(oauth ? ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", metadataPath] : []);
  const metadata = oauth
    ? JSON.stringify({
        resource: oauth.resource,
        authorization_servers: [oauth.authServer],
        scopes_supported: OAUTH_SCOPES,
        bearer_methods_supported: ["header"],
        resource_documentation: opts.resourceDocumentation ?? DEFAULT_DOCUMENTATION,
      })
    : "";
  /** The 401 challenge: where the protected resource metadata is and which scopes to ask for; `error` once a token was sent and refused. */
  const challenge = (refused: boolean) =>
    oauth && resourceUrl
      ? `Bearer resource_metadata="${resourceUrl.origin}${metadataPath}", scope="${OAUTH_SCOPES.join(" ")}"${refused ? ', error="invalid_token"' : ""}`
      : "Bearer";

  // The factory sees the caller's token as `authInfo` (set below from the Bearer header): one Boxline client per request. An OAuth
  // token (bxo_) always gets the directory tools: no saved-credential tools, whatever MCP_TOOLS says (the API refuses saved
  // credentials to such a token anyway). Every tool says it uses OAuth when this server offers it.
  const mcp = createMcpHandler(
    (ctx) => {
      const token = ctx.authInfo?.token;
      if (!token) throw new Error("no API key on the request");
      return createServer(new Boxline({ apiKey: token, baseUrl: opts.apiUrl }), {
        tools: token.startsWith(OAUTH_TOKEN_PREFIX) ? "directory" : opts.tools,
        liveUrls: false,
        oauth: oauth !== null,
      });
    },
    // `sse`: always stream, so keep-alive frames flow during a long tool call (browser_login can wait minutes for a code).
    { legacy: "stateless", responseMode: "sse", maxRequestBodySize: maxBody, keepAliveMs: opts.keepAliveMs, onerror },
  );
  const serve = toNodeHandler(mcp, { maxRequestBodySize: maxBody, onerror });

  const handler = (async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/healthz") {
        if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "method not allowed", { allow: "GET, HEAD" });
        return reply(res, 200, req.method === "HEAD" ? "" : "ok");
      }

      // Public documents: the protected resource metadata (read by MCP clients and, from browsers, by inspectors, so any origin may read
      // it) and OpenAI's domain check. The Host is still checked; no token is needed.
      if (metadataPaths.has(path) || path === "/.well-known/openai-apps-challenge") {
        if (!hostAllowed(req.headers.host, allowedHosts)) return reply(res, 403, "Host not allowed", { connection: "close" });
        if (req.method === "OPTIONS") return reply(res, 204, "", { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "content-type" });
        if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "method not allowed", { allow: "GET, HEAD, OPTIONS" });
        const head = req.method === "HEAD";
        if (path === "/.well-known/openai-apps-challenge") {
          return opts.openaiChallenge ? reply(res, 200, head ? "" : opts.openaiChallenge) : reply(res, 404, "not found");
        }
        return reply(res, 200, head ? "" : metadata, { "content-type": "application/json", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" });
      }

      if (path !== "/mcp") return reply(res, 404, "not found", { connection: "close" });

      // Cheap checks first, none of them reads the body.
      if (!hostAllowed(req.headers.host, allowedHosts)) return rpcError(res, 403, "Host not allowed");
      if (!originAllowed(req.headers.origin, allowedHosts)) return rpcError(res, 403, "Origin not allowed");
      const token = bearerToken(req.headers.authorization);
      if (!token) return rpcError(res, 401, "Send your Boxline API key or sign in: Authorization: Bearer <token>", { "www-authenticate": challenge(false) });
      const declared = req.headers["content-length"];
      if (declared !== undefined && Number(declared) > maxBody) return rpcError(res, 413, `Request body too large: the limit is ${maxBody} bytes`);

      if (inFlight >= maxInFlight) return rpcError(res, 503, "Too many requests at once: retry shortly", { "retry-after": "1" });
      const tokenHash = createHash("sha256").update(token).digest("hex");
      if ((perToken.get(tokenHash) ?? 0) >= maxPerToken) return rpcError(res, 503, "Too many requests at once for this token: retry shortly", { "retry-after": "1" });

      // One line per request: the client's address, the MCP method and name (2026-07-28 clients send them as headers),
      // the status and a short hash of the token to tell callers apart. Never the token itself.
      const started = Date.now();
      const key = tokenHash.slice(0, 8);
      const what = [req.headers["mcp-method"], req.headers["mcp-name"]].filter((v) => typeof v === "string" && v).join(" ") || "-";
      inFlight++;
      perToken.set(tokenHash, (perToken.get(tokenHash) ?? 0) + 1);
      res.once("close", () => {
        inFlight--;
        const left = (perToken.get(tokenHash) ?? 1) - 1;
        if (left > 0) perToken.set(tokenHash, left);
        else perToken.delete(tokenHash);
        log(`${req.method} ${res.statusCode} ${Date.now() - started}ms ip=${clientIp(req)} key=${key} ${what.replace(/[^\x20-\x7e]/g, "?").slice(0, 120)}`);
      });

      // The token is checked before anything is served: a token the API refuses (expired, revoked, made up) is a 401 the client acts on
      // (an OAuth client refreshes it or signs in again), not a tool error, and a flood of made-up tokens stops here.
      if ((await checks.check(token)) === false) {
        return rpcError(res, 401, "The token is not valid (expired, revoked or unknown): sign in again or send a current API key", { "www-authenticate": challenge(true) });
      }

      const auth: AuthInfo = { token, clientId: token.startsWith(OAUTH_TOKEN_PREFIX) ? "boxline-oauth" : "boxline-api-key", scopes: [] };
      (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
      await serve(req, res);
    } catch (err) {
      onerror(err instanceof Error ? err : new Error(String(err)));
      if (!res.headersSent) reply(res, 500, "internal error", { connection: "close" });
      else res.end();
    }
  }) as HttpHandler;
  handler.close = () => mcp.close();
  return handler;
}

export interface RunningHttp {
  server: Server;
  port: number;
  /** Stops accepting, lets requests in flight finish (up to `graceMs`, then cuts them), then stops the MCP handler. */
  close(graceMs?: number): Promise<void>;
}

/** Starts the HTTP server. Port 0 picks a free one (`port` says which). */
export async function startHttp(opts: HttpOptions & { port?: number; host?: string } = {}): Promise<RunningHttp> {
  const handler = createHttpHandler(opts);
  const server = createHttpServer((req, res) => void handler(req, res));
  // Longer than a load balancer's idle timeout (60 s by default), so it never reuses a connection this side just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const log = opts.log ?? ((m: string) => process.stderr.write(`boxline-mcp: ${m}\n`));
  await new Promise<void>((resolve, reject) => {
    let listening = false;
    server.on("error", (err) => (listening ? log(`error: ${err.message}`) : reject(err)));
    server.listen(opts.port ?? 8081, opts.host ?? "0.0.0.0", () => {
      listening = true;
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8081);
  return {
    server,
    port,
    async close(graceMs = 5000) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const cut = setTimeout(() => server.closeAllConnections(), graceMs);
      await closed;
      clearTimeout(cut);
      await handler.close();
    },
  };
}
