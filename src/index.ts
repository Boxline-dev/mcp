#!/usr/bin/env node
/**
 * Boxline MCP server. Gives any MCP client (Claude, ChatGPT, Cursor and others) an isolated cloud machine with a browser,
 * a shell and a disk.
 *
 *   boxline-mcp           stdio. Env: BOXLINE_API_KEY, BOXLINE_API_URL (default https://api.boxline.dev, the Node SDK's;
 *                         http://localhost:8080 for a local API).
 *   boxline-mcp --http    HTTP on /mcp (POST). Env: MCP_PORT (8081), MCP_HOST (0.0.0.0), MCP_ALLOWED_HOSTS, MCP_TOOLS
 *                         (full or directory), BOXLINE_API_URL. Each request carries its own API key, or the OAuth access
 *                         token a person gave an MCP client by connecting it, as a Bearer token. MCP_RESOURCE and
 *                         MCP_AUTH_SERVER (both) turn on OAuth sign-in discovery; MCP_OPENAI_CHALLENGE, MCP_TOKEN_CACHE_SECONDS.
 *
 * `session_create` returns a sessionId; every tool that needs a machine takes it as `sessionId` (`session_list` finds one again).
 */
import { Boxline } from "@boxline/sdk";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { httpConfigFromEnv, startHttp } from "./http.js";
import { createServer } from "./server.js";

const USAGE = "Usage: boxline-mcp [--http]\n  (no flag)  serve MCP over stdio, with BOXLINE_API_KEY\n  --http     serve MCP over HTTP at /mcp; see MCP_PORT, MCP_HOST, MCP_ALLOWED_HOSTS, MCP_TOOLS\n";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const unknown = args.filter((a) => a !== "--http");
  if (unknown.length) {
    process.stderr.write(`boxline-mcp: unknown argument ${unknown[0]}\n${USAGE}`);
    process.exit(2);
  }

  if (!args.includes("--http")) {
    const client = new Boxline();
    serveStdio(() => createServer(client));
    return;
  }

  const config = httpConfigFromEnv();
  const running = await startHttp(config);
  process.stderr.write(`boxline-mcp: HTTP on ${config.host}:${running.port}/mcp (tools: ${config.tools}, OAuth sign-in: ${config.resource ? "on" : "off"})\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Let requests in flight finish, but not forever.
    setTimeout(() => process.exit(0), 25_000).unref();
    void running.close(20_000).then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  process.stderr.write(`boxline-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
