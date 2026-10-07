/**
 * The MCP server over HTTP (`boxline-mcp --http`). Stateless: every request builds its own server around the caller's
 * API key (`Authorization: Bearer <API key>`), so any replica can serve any request and a restart loses nothing. There is
 * no protocol session and no default session: a conversation carries the sessionId that `session_create` returned.
 *
 * Plain `node:http` runs our checks first (host, origin, Bearer token, body size, `GET /healthz`), then hands `/mcp` to
 * the MCP SDK's handler, which serves 2026-07-28 clients and, statelessly, the 2025-era ones.
 */
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Boxline } from "@boxline/sdk";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createServer, type ToolSetting } from "./server.js";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Requests served at once; more get 503, so a flood cannot run the container out of memory. */
export const MAX_IN_FLIGHT = 32;
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
  /** SSE keep-alive interval in ms (default 15 000): bytes keep flowing while a long tool call runs, so a load balancer's idle timeout does not cut it. */
  keepAliveMs?: number;
  /** Where errors are reported (message only; never a token or a request). Defaults to stderr. */
  log?: (message: string) => void;
}

/** The HTTP settings from the environment: MCP_PORT, MCP_HOST, MCP_ALLOWED_HOSTS, MCP_TOOLS, MCP_MAX_IN_FLIGHT, BOXLINE_API_URL. Throws on a bad value. */
export function httpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions & { port: number; host: string } {
  const port = env.MCP_PORT === undefined || env.MCP_PORT === "" ? 8081 : Number(env.MCP_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`MCP_PORT must be a port number, got "${env.MCP_PORT}"`);
  const tools = env.MCP_TOOLS === undefined || env.MCP_TOOLS === "" ? "full" : env.MCP_TOOLS;
  if (tools !== "full" && tools !== "directory") throw new Error(`MCP_TOOLS must be "full" or "directory", got "${env.MCP_TOOLS}"`);
  return {
    port,
    host: env.MCP_HOST || "0.0.0.0",
    apiUrl: env.BOXLINE_API_URL || undefined,
    tools,
    maxInFlight: env.MCP_MAX_IN_FLIGHT ? Number(env.MCP_MAX_IN_FLIGHT) : undefined,
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

export function createHttpHandler(opts: HttpOptions = {}): HttpHandler {
  const allowedHosts = opts.allowedHosts ?? [];
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxInFlight = opts.maxInFlight ?? MAX_IN_FLIGHT;
  let inFlight = 0;
  const log = opts.log ?? ((m: string) => process.stderr.write(`boxline-mcp: ${m}\n`));
  const onerror = (err: Error) => log(`error: ${err.message}`);

  // The factory sees the caller's key as `authInfo` (set below from the Bearer header): one Boxline client per request.
  const mcp = createMcpHandler(
    (ctx) => {
      const token = ctx.authInfo?.token;
      if (!token) throw new Error("no API key on the request");
      return createServer(new Boxline({ apiKey: token, baseUrl: opts.apiUrl }), { tools: opts.tools, liveUrls: false });
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
      if (path !== "/mcp") return reply(res, 404, "not found", { connection: "close" });

      // Cheap checks first, none of them reads the body.
      if (!hostAllowed(req.headers.host, allowedHosts)) return rpcError(res, 403, "Host not allowed");
      if (!originAllowed(req.headers.origin, allowedHosts)) return rpcError(res, 403, "Origin not allowed");
      const token = bearerToken(req.headers.authorization);
      if (!token) return rpcError(res, 401, "Send your Boxline API key as Authorization: Bearer <API key>", { "www-authenticate": "Bearer" });
      const declared = req.headers["content-length"];
      if (declared !== undefined && Number(declared) > maxBody) return rpcError(res, 413, `Request body too large: the limit is ${maxBody} bytes`);

      if (inFlight >= maxInFlight) return rpcError(res, 503, "Too many requests at once: retry shortly", { "retry-after": "1" });

      // One line per request: the client's address, the MCP method and name (2026-07-28 clients send them as headers),
      // the status and a short hash of the key to tell callers apart. Never the key itself.
      const started = Date.now();
      const key = createHash("sha256").update(token).digest("hex").slice(0, 8);
      const what = [req.headers["mcp-method"], req.headers["mcp-name"]].filter((v) => typeof v === "string" && v).join(" ") || "-";
      inFlight++;
      res.once("close", () => {
        inFlight--;
        log(`${req.method} ${res.statusCode} ${Date.now() - started}ms ip=${clientIp(req)} key=${key} ${what.replace(/[^\x20-\x7e]/g, "?").slice(0, 120)}`);
      });

      const auth: AuthInfo = { token, clientId: "boxline-api-key", scopes: [] };
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
