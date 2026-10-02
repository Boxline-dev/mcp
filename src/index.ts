#!/usr/bin/env node
/**
 * Boxline MCP server (stdio). Gives any MCP client — Claude, Cursor, and others — an isolated cloud
 * machine with a browser, a shell and a disk. Env: BOXLINE_API_KEY, BOXLINE_API_URL (default https://api.boxline.dev,
 * the Node SDK's; http://localhost:8080 for a local API).
 *
 * Every tool takes an optional sessionId; without one, the server uses (or creates) a default session,
 * so an agent can simply call `browser_navigate` and start working.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Boxline, BoxlineError, type Session } from "@boxline/sdk";
import { z } from "zod";

const client = new Boxline();
const server = new McpServer({ name: "boxline", version: "0.1.0" });

let current: Session | null = null;
const TEXT_LIMIT = 40_000;

/** Long enough for agent work, but never above what the account's plan allows. */
let maxTimeout: number | null = null;
async function defaultTimeout() {
  maxTimeout ??= await client
    .me()
    .then((m) => m.project.limits.maxTimeoutSeconds)
    .catch(() => 900);
  return Math.min(1800, maxTimeout);
}

async function session(id?: string): Promise<Session> {
  if (id) return client.sessions.get(id);
  if (current) {
    await current.refresh().catch(() => undefined);
    if (current.status === "RUNNING" || current.status === "PAUSED") return current;
  }
  const timeout = await defaultTimeout();
  try {
    current = await client.sessions.create({ browser: true, shell: true, timeout });
  } catch (err) {
    // No shells here (a plan without them, or a local API that doesn't allow them): a browser-only session still
    // serves every browser, file and fetch tool.
    if (!/shell/i.test(err instanceof Error ? err.message : String(err))) throw err;
    current = await client.sessions.create({ browser: true, shell: false, timeout });
  }
  return current;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT)}\n[… truncated]` : s }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof BoxlineError ? `${err.code}: ${err.message}` : String(err) }],
});
const sessionId = z.string().optional().describe("Session id; omit to use the default session");

function tool<S extends z.ZodRawShape>(name: string, description: string, schema: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<any>) {
  server.registerTool(name, { description, inputSchema: schema }, (async (args: z.infer<z.ZodObject<S>>) => {
    try {
      return await run(args);
    } catch (err) {
      return fail(err);
    }
  }) as never);
}

/**
 * Browser settings the API takes on sessions and fetch (docs/CONTRACT.md). Not in the SDK's types yet, so they are
 * passed in a separate object (the SDK sends every field it is given).
 */
type BrowserSettings = { blockAds?: boolean; cookieBanners?: "reject" | "off" };

tool(
  "session_create",
  "Create a new isolated session (Chrome browser + optional bash shell + shared /workspace disk) and make it the default. " +
    "Optionally browse through a proxy: proxyType residential (home IPs) or datacenter, with proxyCountry (two letters) and, for residential, proxyCity. " +
    "blockAds: refuse ad and tracker sites (faster, less clutter). cookieBanners: \"reject\" (default) answers cookie consent banners with Reject all, \"off\" leaves them.",
  {
    shell: z.boolean().optional(),
    timeout: z.number().optional(),
    proxyType: z.enum(["residential", "datacenter"]).optional(),
    proxyCountry: z.string().length(2).optional(),
    proxyCity: z.string().optional(),
    blockAds: z.boolean().optional(),
    cookieBanners: z.enum(["reject", "off"]).optional(),
  },
  async (a) => {
    const proxy = a.proxyType
      ? a.proxyType === "residential"
        ? { type: "residential" as const, country: a.proxyCountry, city: a.proxyCity }
        : { type: "datacenter" as const, country: a.proxyCountry }
      : undefined;
    const settings: BrowserSettings = { blockAds: a.blockAds, cookieBanners: a.cookieBanners };
    const params = { browser: true, shell: a.shell ?? true, timeout: a.timeout ?? (await defaultTimeout()), proxy, ...settings };
    current = await client.sessions.create(params);
    return text(JSON.stringify({ sessionId: current.id, liveUrl: current.liveUrl, workspace: current.workspacePath }, null, 2));
  },
);

tool("session_close", "Release a session (stops billing).", { sessionId }, async (a) => {
  const s = await session(a.sessionId);
  await s.release();
  if (current?.id === s.id) current = null;
  return text(`Session ${s.id} released.`);
});

tool("session_move", "Move the session to a fresh machine, keeping tabs, logins, form values and files.", { sessionId }, async (a) => {
  const s = await session(a.sessionId);
  return text(`Moved in ${(await s.move()).totalMs} ms.`);
});

tool("browser_navigate", "Open a URL in the session's browser.", { sessionId, url: z.string() }, async (a) => {
  const v = await (await session(a.sessionId)).goto(a.url);
  return text(`Loaded ${v.url} (HTTP ${v.status ?? "?"}) — ${v.title}`);
});

tool(
  "browser_click",
  "Click an element (Playwright selector such as `text=Sign in` or `#submit`) or at page coordinates.",
  { sessionId, selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
  async (a) => {
    const [r] = await (await session(a.sessionId)).actions({ action: "click", selector: a.selector, x: a.x, y: a.y });
    return r?.ok ? text("Clicked.") : fail(r?.error);
  },
);

tool("browser_type", "Type text, optionally into the element matched by selector.", { sessionId, text: z.string(), selector: z.string().optional() }, async (a) => {
  const [r] = await (await session(a.sessionId)).actions({ action: "type", text: a.text, selector: a.selector });
  return r?.ok ? text("Typed.") : fail(r?.error);
});

tool("browser_press", "Press a key, e.g. Enter or Control+A.", { sessionId, key: z.string() }, async (a) => {
  const [r] = await (await session(a.sessionId)).actions({ action: "press", key: a.key });
  return r?.ok ? text(`Pressed ${a.key}.`) : fail(r?.error);
});

// ---------- mouse and keyboard (coordinates are CSS pixels of the viewport) ----------
// These call the API directly: the SDK's typed action list does not have the mouse actions yet.

interface ActionResult {
  ok: boolean;
  value?: any;
  error?: string;
  code?: string;
  text?: string;
}
async function input(id: string | undefined, action: Record<string, unknown>) {
  const s = await session(id);
  const { results } = await client.request<{ results: ActionResult[] }>("POST", `/v1/sessions/${s.id}/actions`, { actions: [action] });
  const r = results[0];
  return r?.ok ? text(r.text ?? "Done.") : fail(r?.error ?? "the action failed");
}
const point = { x: z.number().optional(), y: z.number().optional() };

tool(
  "mouse_move",
  "Move the pointer to x/y (CSS pixels of the viewport). steps > 1 moves in a straight line through that many points (1-100), for pages that follow the pointer.",
  { sessionId, x: z.number(), y: z.number(), steps: z.number().int().min(1).max(100).optional() },
  (a) => input(a.sessionId, { action: "move", x: a.x, y: a.y, steps: a.steps }),
);

tool(
  "mouse_click",
  "Click at x/y or on a selector: button left (default), right (context menu) or middle; count 2 for a double click, 3 for a triple click.",
  { sessionId, ...point, selector: z.string().optional(), button: z.enum(["left", "right", "middle"]).optional(), count: z.number().int().min(1).max(3).optional() },
  (a) => input(a.sessionId, { action: "click", selector: a.selector, x: a.x, y: a.y, button: a.button, count: a.count as 1 | 2 | 3 | undefined }),
);

tool(
  "mouse_drag",
  "Drag with the left button held: from a selector or fromX/fromY to a selector or toX/toY (e.g. a slider handle or a list item), or along path (up to 200 {x, y} points).",
  {
    sessionId,
    fromSelector: z.string().optional(),
    fromX: z.number().optional(),
    fromY: z.number().optional(),
    toSelector: z.string().optional(),
    toX: z.number().optional(),
    toY: z.number().optional(),
    path: z.array(z.object({ x: z.number(), y: z.number() })).max(200).optional(),
    steps: z.number().int().min(1).max(100).optional(),
  },
  (a) => {
    const end = (sel?: string, x?: number, y?: number) => sel ?? (x !== undefined && y !== undefined ? { x, y } : undefined);
    return input(a.sessionId, a.path ? { action: "drag", path: a.path, steps: a.steps } : { action: "drag", from: end(a.fromSelector, a.fromX, a.fromY), to: end(a.toSelector, a.toX, a.toY), steps: a.steps });
  },
);

tool("hover", "Move the pointer over a selector or to x/y, e.g. to open a menu that shows on hover.", { sessionId, selector: z.string().optional(), ...point }, (a) =>
  input(a.sessionId, { action: "hover", selector: a.selector, x: a.x, y: a.y }),
);

tool("key", "Press a key combination, e.g. Control+A, Shift+Tab, Meta+C (or one key: Enter, Escape, ArrowDown).", { sessionId, keys: z.string() }, (a) =>
  input(a.sessionId, { action: "key", keys: a.keys }),
);

tool(
  "computer",
  "Run ONE computer-use action as a model's computer tool gives it, in Anthropic's shape ({action:'left_click', coordinate:[x, y]}) or OpenAI's ({type:'click', x, y, button}), " +
    "then see the screen. Coordinates are pixels of the screenshot; with maxWidth the screenshot is scaled down and coordinates are scaled back.",
  { sessionId, action: z.record(z.string(), z.unknown()).describe("The provider's action object"), maxWidth: z.number().int().min(100).max(3840).optional(), screenshot: z.boolean().optional() },
  async (a) => {
    const s = await session(a.sessionId);
    const r = await client.request<{ ok: boolean; error?: string; text: string; screenshot: string | null; mimeType: string | null; scale: number; cursor: { x: number; y: number }; url: string; title: string }>(
      "POST",
      `/v1/sessions/${s.id}/computer`,
      { ...a.action, maxWidth: a.maxWidth, screenshot: a.screenshot },
    );
    const summary = `${r.ok ? r.text : `Failed: ${r.error}`}\nPointer: (${r.cursor.x}, ${r.cursor.y}) · scale ${r.scale} · ${r.title} — ${r.url}`;
    return {
      ...(r.ok ? {} : { isError: true }),
      content: [{ type: "text" as const, text: summary }, ...(r.screenshot ? [{ type: "image" as const, data: r.screenshot, mimeType: r.mimeType ?? "image/png" }] : [])],
    };
  },
);

tool("browser_screenshot", "Screenshot the current tab.", { sessionId, fullPage: z.boolean().optional() }, async (a) => {
  const shot = await (await session(a.sessionId)).screenshot({ format: "jpeg", quality: 60, fullPage: a.fullPage });
  return { content: [{ type: "image" as const, data: shot.data, mimeType: shot.mimeType }] };
});

tool("browser_read", "Read the current page as markdown or plain text.", { sessionId, format: z.enum(["markdown", "text"]).optional() }, async (a) => {
  const v = await (await session(a.sessionId)).content(a.format ?? "markdown");
  return text(`# ${v.title}\n${v.url}\n\n${v.content}`);
});

tool(
  "run_command",
  "Run a bash command in the session's persistent shell (cd and export persist). Working directory starts at the workspace; browser downloads are in ./downloads.",
  { sessionId, command: z.string(), timeoutMs: z.number().optional() },
  async (a) => {
    const r = await (await session(a.sessionId)).exec(a.command, { timeoutMs: a.timeoutMs ?? 120_000 });
    const out = [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)";
    return text(`${out}\n[exit code ${r.exitCode ?? "timeout"}]`);
  },
);

tool(
  "run_playwright",
  "Run Playwright JavaScript inside the session's sandbox, next to its browser. `page`, `context`, `browser` and `env` are in scope; top-level await works; a returned value is printed. Do not call browser.close(). `step(instruction)` and `extract(instruction, schema?)` use the call's own {provider, model}, else the last `useModel(model)` / `useModel(provider, model)` in the code, else `ai`.",
  {
    sessionId,
    code: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().optional(),
    ai: z.object({ provider: z.enum(["anthropic", "openai", "xai", "google"]).optional(), model: z.string().optional() }).optional(),
  },
  async (a) => {
    const r = await (await session(a.sessionId)).runScript(a.code, { env: a.env, timeoutMs: a.timeoutMs ?? 120_000, ai: a.ai });
    const out = [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)";
    return { ...text(`${out}\n[exit code ${r.exitCode ?? "timeout"}]`), ...(r.exitCode === 0 ? {} : { isError: true }) };
  },
);

tool("list_files", "List files in the session workspace.", { sessionId, path: z.string().optional() }, async (a) => {
  const r = await (await session(a.sessionId)).files.list(a.path ?? ".");
  return text(r.entries.map((e) => `${e.type === "dir" ? "d" : "-"} ${String(e.size).padStart(10)}  ${e.name}`).join("\n") || "(empty)");
});

tool("read_file", "Read a text file from the session workspace.", { sessionId, path: z.string() }, async (a) => {
  return text(await (await session(a.sessionId)).files.readText(a.path));
});

tool("write_file", "Write a text file into the session workspace.", { sessionId, path: z.string(), content: z.string() }, async (a) => {
  const r = await (await session(a.sessionId)).files.write(a.path, a.content);
  return text(`Wrote ${r.size} bytes to ${r.path}.`);
});

tool(
  "fetch_url",
  "Fetch a web page through a real browser and return markdown, HTML or text (no session needed). blockAds: refuse ad and tracker sites while loading it.",
  { url: z.string(), format: z.enum(["markdown", "html", "text"]).optional(), blockAds: z.boolean().optional() },
  async (a) => {
    const settings: BrowserSettings = { blockAds: a.blockAds };
    const opts = { format: a.format ?? "markdown", ...settings };
    const r = await client.fetch(a.url, opts);
    return text(`# ${r.title}\n${r.finalUrl} (HTTP ${r.status})\n\n${r.content}`);
  },
);

/** POST /v1/search. Uses the SDK's low-level request until the SDK has its own search method. */
interface SearchAnswer {
  query: string;
  cached: boolean;
  results: { title: string; url: string; snippet: string; publishedAt?: string; siteName?: string; content?: string | null; error?: { code: string; message: string } | null }[];
}

tool(
  "web_search",
  "Search the web (no session needed). Returns titles, URLs and snippets of the top results; open one with browser_navigate or fetch_url. " +
    "Set fetch to also get the top 1 to 5 pages as Markdown in the same call. Each search counts against the plan's monthly searches (the same search within an hour is free).",
  {
    query: z.string().min(1).max(400),
    limit: z.number().int().min(1).max(20).optional().describe("Results, 1 to 20 (default 10)"),
    country: z.string().optional().describe("Two-letter country code the results come from, e.g. DE"),
    language: z.string().optional().describe("Language of the results, e.g. de"),
    recency: z.enum(["day", "week", "month", "year"]).optional(),
    fetch: z.number().int().min(0).max(5).optional().describe("Also return the top N pages as Markdown (0 to 5)"),
  },
  async (a) => {
    const r = await client.request<SearchAnswer>("POST", "/v1/search", {
      query: a.query,
      limit: a.limit,
      country: a.country,
      language: a.language,
      recency: a.recency,
      fetch: a.fetch || undefined,
    });
    if (!r.results.length) return text(`No results for "${r.query}".`);
    const lines = r.results.map((x, i) => {
      const head = `${i + 1}. ${x.title}\n   ${x.url}${x.publishedAt ? ` (${x.publishedAt.slice(0, 10)})` : ""}\n   ${x.snippet}`;
      if (x.error) return `${head}\n   [could not load the page: ${x.error.code}: ${x.error.message}]`;
      return x.content ? `${head}\n\n${x.content}\n` : head;
    });
    return text(`Search results for "${r.query}"${r.cached ? " (cached)" : ""}:\n\n${lines.join("\n\n")}`);
  },
);

await server.connect(new StdioServerTransport());
