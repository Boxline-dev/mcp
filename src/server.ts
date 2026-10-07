/**
 * The Boxline MCP server: one function that builds a server around a Boxline client. The stdio entry builds it once
 * per connection; the HTTP entry builds one per request, around that request's own API key. It keeps no state between
 * calls: `session_create` returns a session id and every tool that needs a machine takes it as `sessionId` (a stopped
 * session is resumed first, as it was).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { Boxline, BoxlineError, CredentialLoginFailedError, type Session } from "@boxline/sdk";
import { z } from "zod";
import { VERSION } from "./version.js";

/** `full`: every tool. `directory`: no saved-credential tools and no credential parameters (for public connector directories). */
export type ToolSetting = "full" | "directory";

export interface ServerOptions {
  tools?: ToolSetting;
  /** Whether session_create and session_resume return the signed live view URL (a bearer link that controls the browser). Off when hosted. Default true. */
  liveUrls?: boolean;
}

const TEXT_LIMIT = 40_000;

const INSTRUCTIONS =
  "Boxline gives you an isolated cloud machine: a Chrome browser, a bash shell and a /workspace disk. " +
  "Call session_create first and pass the sessionId it returns to every other session tool. " +
  "fetch_url and web_search need no session. Call session_stop when you are done: billing stops and session_resume brings the session back as it was.";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT)}\n[… truncated]` : s }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof BoxlineError ? `${err.code}: ${err.message}` : String(err) }],
});

/**
 * What a tool does to the world, as the MCP annotations say it (clients use these to decide what to ask the user about):
 * `read` changes nothing, `change` changes something but never deletes or overwrites, `destroy` can delete or overwrite.
 * `web` is true when the tool reaches out to the open web.
 */
type Effect = "read" | "change" | "destroy";
interface ToolMeta {
  title: string;
  description: string;
  effect: Effect;
  web: boolean;
  /** Parameters left out of the `directory` setting (the credential ones). */
  omitInDirectory?: string[];
}

/**
 * Browser settings the API takes on sessions and fetch (docs/CONTRACT.md). Not in the SDK's types yet, so they are
 * passed in a separate object (the SDK sends every field it is given).
 */
type BrowserSettings = { blockAds?: boolean; cookieBanners?: "reject" | "off" };

interface ActionResult {
  ok: boolean;
  value?: any;
  error?: string;
  code?: string;
  text?: string;
}

/** POST /v1/search. Uses the SDK's low-level request until the SDK has its own search method. */
interface SearchAnswer {
  query: string;
  cached: boolean;
  results: { title: string; url: string; snippet: string; publishedAt?: string; siteName?: string; content?: string | null; error?: { code: string; message: string } | null }[];
}

export function createServer(client: Boxline, opts: ServerOptions = {}): McpServer {
  const full = (opts.tools ?? "full") === "full";
  const live = (s: Session) => (opts.liveUrls ?? true ? { liveUrl: s.liveUrl } : {});
  const server = new McpServer({ name: "boxline", version: VERSION }, { instructions: INSTRUCTIONS });

  function tool<S extends z.ZodRawShape>(name: string, meta: ToolMeta, schema: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<any>) {
    const shape = full || !meta.omitInDirectory ? schema : (Object.fromEntries(Object.entries(schema).filter(([k]) => !meta.omitInDirectory!.includes(k))) as S);
    server.registerTool(
      name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: z.object(shape),
        annotations: { title: meta.title, readOnlyHint: meta.effect === "read", destructiveHint: meta.effect === "destroy", openWorldHint: meta.web },
      },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return await run(args);
        } catch (err) {
          return fail(err);
        }
      }) as never,
    );
  }

  /** Long enough for agent work, but never above what the account's plan allows. */
  async function defaultTimeout() {
    const max = await client
      .me()
      .then((m) => m.project.limits.maxTimeoutSeconds)
      .catch(() => 900);
    return Math.min(1800, max);
  }

  /**
   * The machine a tool works in. A stopped session is brought back as it was (a new machine: billing starts again), except
   * for the read-only tools, which say so instead; anything else the API refuses says so.
   */
  async function machine(id: string, resume = true): Promise<Session> {
    const s = await client.sessions.get(id);
    if (s.status !== "STOPPED") return s;
    if (!resume) throw new Error(`session ${id} is stopped: call session_resume to start it again, then retry`);
    return s.resume();
  }

  const sessionId = z.string().min(1).describe("Id of the session, from session_create");

  // ---------- sessions ----------

  tool(
    "session_create",
    {
      title: "Create a session",
      description:
        "Create a new isolated session (Chrome browser + optional bash shell + shared /workspace disk). Returns its sessionId: pass it to every other session tool. " +
        "Optionally browse through a proxy: proxyType residential (home IPs) or datacenter, with proxyCountry (two letters) and, for residential, proxyCity. " +
        "blockAds: refuse ad and tracker sites (faster, less clutter). cookieBanners: \"reject\" (default) answers cookie consent banners with Reject all, \"off\" leaves them. " +
        "profile: the id of a saved browser profile to start from (its cookies and logins); persistProfile saves what the session signs in to back into it when it ends." +
        (full
          ? " credentials: names of saved credentials (see credentials_list) to export into the shell as environment variables, only those whose scope allows the shell; needs a shell. " +
            "To sign in on a page, do not export anything: use browser_type with a credential."
          : ""),
      effect: "change",
      web: false,
      omitInDirectory: ["credentials"],
    },
    {
      shell: z.boolean().optional(),
      timeout: z.number().optional(),
      proxyType: z.enum(["residential", "datacenter"]).optional(),
      proxyCountry: z.string().length(2).optional(),
      proxyCity: z.string().optional(),
      blockAds: z.boolean().optional(),
      cookieBanners: z.enum(["reject", "off"]).optional(),
      profile: z.string().optional().describe("Id of a saved browser profile to start from"),
      persistProfile: z.boolean().optional().describe("Save the session's logins back into the profile when it stops"),
      credentials: z.array(z.string()).max(50).optional().describe("Names of saved credentials to export into the shell (needs a shell)"),
    },
    async (a) => {
      const proxy = a.proxyType
        ? a.proxyType === "residential"
          ? { type: "residential" as const, country: a.proxyCountry, city: a.proxyCity }
          : { type: "datacenter" as const, country: a.proxyCountry }
        : undefined;
      const settings: BrowserSettings = { blockAds: a.blockAds, cookieBanners: a.cookieBanners };
      if (a.persistProfile && !a.profile) throw new Error("persistProfile needs a profile id");
      const profile = a.profile ? { id: a.profile, persist: a.persistProfile ?? false } : undefined;
      const credentials = full && a.credentials?.length ? a.credentials : undefined;
      const timeout = a.timeout ?? (await defaultTimeout());
      const params = { browser: true, shell: a.shell ?? true, timeout, proxy, profile, credentials, ...settings };
      let s: Session;
      try {
        s = await client.sessions.create(params);
      } catch (err) {
        // No shells here (a plan without them, or a local API that doesn't allow them) and none was asked for: a
        // browser-only session still serves every browser, file and fetch tool.
        if (a.shell !== undefined || !/shell/i.test(err instanceof Error ? err.message : String(err))) throw err;
        s = await client.sessions.create({ ...params, shell: false, credentials: undefined });
      }
      return text(JSON.stringify({ sessionId: s.id, ...live(s), workspace: s.workspacePath, shell: s.data.shell }, null, 2));
    },
  );

  tool(
    "session_stop",
    {
      title: "Stop a session",
      description:
        "Stop a session: it is saved exactly as it is (every tab, the files) and billing stops. Resume it later with session_resume; it is kept for the plan's retention days, then deleted.",
      effect: "change",
      web: false,
    },
    { sessionId },
    async (a) => {
      const s = await client.sessions.get(a.sessionId);
      await s.stop();
      return text(`Session ${s.id} stopped. It is kept until ${s.data.deletesAt ?? "its retention days pass"}; session_resume brings it back.`);
    },
  );

  tool(
    "session_resume",
    {
      title: "Resume a stopped session",
      description: "Resume a stopped session on a fresh machine, as it was when it stopped (same id, tabs and files). The other session tools also do this on their own when given the id of a stopped session.",
      effect: "change",
      web: false,
    },
    { sessionId: z.string().min(1).describe("Id of the stopped session, from session_create") },
    async (a) => {
      const s = await client.sessions.get(a.sessionId);
      await s.resume();
      return text(JSON.stringify({ sessionId: s.id, ...live(s), workspace: s.workspacePath }, null, 2));
    },
  );

  tool(
    "session_delete",
    {
      title: "Delete a session",
      description: "Delete a session for good: what it saved, its recording and its logs are deleted now. This cannot be undone; use session_stop to keep it.",
      effect: "destroy",
      web: false,
    },
    { sessionId: z.string().min(1).describe("Id of the session to delete, from session_create") },
    async (a) => {
      const s = await client.sessions.get(a.sessionId);
      await s.delete();
      return text(`Session ${s.id} deleted.`);
    },
  );

  tool(
    "session_move",
    { title: "Move a session to a fresh machine", description: "Move the session to a fresh machine, keeping tabs, logins, form values and files.", effect: "change", web: false },
    { sessionId },
    async (a) => {
      const s = await machine(a.sessionId);
      return text(`Moved in ${(await s.move()).totalMs} ms.`);
    },
  );

  // ---------- saved credentials (not in the directory setting) ----------

  if (full) {
    /**
     * GET /v1/credentials, shown without anything but what the model needs to choose one: names, types, sites, where each
     * may be used, which parts of a password browser_type can type and where its 2FA codes come from. The API never returns
     * a value; this adds none (nor the address a code source "url" asks, nor its signing secret). There is deliberately no
     * tool that creates or changes a credential: that would send passwords through the chat.
     */
    tool(
      "credentials_list",
      {
        title: "List saved credentials",
        description:
          "List the project's saved credentials (passwords and secrets): name, type, the sites each may be typed on, and for a password which fields browser_type can type and where its 2FA codes come from (codeSource: totp, push, url, or null for no 2FA). " +
          "Never shows a value. Use a name with browser_type's credential, in browser_login, or in session_create's credentials. Credentials are added by the user in the Boxline console, the CLI or an SDK, not here.",
        effect: "read",
        web: false,
      },
      {},
      async () => {
        const rows: { name: string; type: string; sites: string[] | "any"; scope: string; fields?: string[]; codeSource?: string | null; browserType: boolean }[] = [];
        for await (const c of client.credentials.list({ limit: 200 })) {
          const codeSource = c.type === "password" ? (c.codeSource ?? (c.hasTotp ? "totp" : null)) : null;
          rows.push({
            name: c.name,
            type: c.type,
            sites: c.origins?.length ? c.origins : "any",
            scope: c.scope,
            ...(c.type === "password" ? { fields: ["username", "password", ...(codeSource ? ["otp"] : [])], codeSource } : {}),
            // Scope "shell" is not for the AI: browser_type would be refused.
            browserType: c.scope !== "shell",
          });
        }
        if (!rows.length) return text("No credentials saved. Ask the user to add one in the Boxline console.");
        return text(JSON.stringify(rows, null, 2));
      },
    );

    tool(
      "browser_login",
      {
        title: "Sign in with a saved credential",
        description:
          "Sign the session's browser in with a saved password credential (a name from credentials_list), in one call: a short run in the session types the credential on its own sites only, " +
          "and you never see the password or any 2FA code or sign-in link. Give url to start from the site's sign-in page (it must be one of the credential's sites; default: the first). " +
          "A credential whose codeSource is push or url waits for the code or link the user's system sends, up to its timeout: the call can take a few minutes, so tell the user a code is needed. " +
          "Returns the page it ends on. Needs a session with a browser.",
        effect: "change",
        web: true,
      },
      {
        sessionId,
        credential: z.string().describe("Name of a saved password credential (credentials_list)"),
        url: z.string().optional().describe("The sign-in page, on one of the credential's sites"),
      },
      async (a) => {
        const s = await machine(a.sessionId);
        try {
          const v = await s.login(a.credential, a.url !== undefined ? { url: a.url } : {});
          return text(`Signed in with ${a.credential}: ${v.title || "(no title)"} (${v.url}).`);
        } catch (err) {
          if (err instanceof CredentialLoginFailedError) return fail(`${err.code}: ${err.message}${err.runId ? ` (run ${err.runId})` : ""}`);
          throw err;
        }
      },
    );
  }

  // ---------- browser ----------

  tool("browser_navigate", { title: "Open a URL", description: "Open a URL in the session's browser.", effect: "change", web: true }, { sessionId, url: z.string() }, async (a) => {
    const v = await (await machine(a.sessionId)).goto(a.url);
    return text(`Loaded ${v.url} (HTTP ${v.status ?? "?"}) — ${v.title}`);
  });

  tool(
    "browser_click",
    {
      title: "Click an element",
      description: "Click an element (Playwright selector such as `text=Sign in` or `#submit`) or at page coordinates.",
      effect: "change",
      web: true,
    },
    { sessionId, selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
    async (a) => {
      const [r] = await (await machine(a.sessionId)).actions({ action: "click", selector: a.selector, x: a.x, y: a.y });
      return r?.ok ? text("Clicked.") : fail(r?.error);
    },
  );

  tool(
    "browser_type",
    {
      title: "Type text",
      description: full
        ? "Type text, optionally into the element matched by selector. To type a saved password or secret, give credential (a name from credentials_list) instead of text: " +
          "the platform types it without you seeing it. For a password also give field: username, password or otp (the current 2FA code, when credentials_list says it has 2FA; with codeSource push or url it waits for the code the user's system sends). " +
          "A password goes only into the field selector names, and only on the sites it was saved for. Never ask the user to paste a password into the chat."
        : "Type text, optionally into the element matched by selector.",
      effect: "change",
      web: true,
      omitInDirectory: ["credential", "field"],
    },
    {
      sessionId,
      text: full ? z.string().optional() : z.string(),
      selector: z.string().optional(),
      credential: z.string().optional().describe("Name of a saved credential (credentials_list) to type instead of text"),
      field: z.enum(["username", "password", "otp"]).optional().describe("Which part of a password credential to type"),
    },
    async (a) => {
      const credential = full ? a.credential : undefined;
      const field = full ? a.field : undefined;
      if (credential !== undefined && a.text !== undefined) return fail("give text or credential, not both");
      if (credential === undefined && a.text === undefined) return fail(full ? "give the text to type, or a credential to type" : "give the text to type");
      if (credential === undefined && field !== undefined) return fail("field is only for credential");
      const s = await machine(a.sessionId);
      const [r] = await s.actions(credential !== undefined ? { action: "type", credential, field, selector: a.selector } : { action: "type", text: a.text!, selector: a.selector });
      if (r?.ok) return text(credential !== undefined ? (r.text ?? `Typed ${credential}.`) : "Typed.");
      return fail(r?.code ? `${r.code}: ${r.error ?? "the action failed"}` : r?.error);
    },
  );

  tool("browser_press", { title: "Press a key", description: "Press a key, e.g. Enter or Control+A.", effect: "change", web: true }, { sessionId, key: z.string() }, async (a) => {
    const [r] = await (await machine(a.sessionId)).actions({ action: "press", key: a.key });
    return r?.ok ? text(`Pressed ${a.key}.`) : fail(r?.error);
  });

  // ---------- mouse and keyboard (coordinates are CSS pixels of the viewport) ----------
  // These call the API directly: the SDK's typed action list does not have the mouse actions yet.

  async function input(id: string, action: Record<string, unknown>) {
    const s = await machine(id);
    const { results } = await client.request<{ results: ActionResult[] }>("POST", `/v1/sessions/${s.id}/actions`, { actions: [action] });
    const r = results[0];
    return r?.ok ? text(r.text ?? "Done.") : fail(r?.error ?? "the action failed");
  }
  const point = { x: z.number().optional(), y: z.number().optional() };

  tool(
    "mouse_move",
    {
      title: "Move the pointer",
      description: "Move the pointer to x/y (CSS pixels of the viewport). steps > 1 moves in a straight line through that many points (1-100), for pages that follow the pointer.",
      effect: "change",
      web: true,
    },
    { sessionId, x: z.number(), y: z.number(), steps: z.number().int().min(1).max(100).optional() },
    (a) => input(a.sessionId, { action: "move", x: a.x, y: a.y, steps: a.steps }),
  );

  tool(
    "mouse_click",
    {
      title: "Click at a point",
      description: "Click at x/y or on a selector: button left (default), right (context menu) or middle; count 2 for a double click, 3 for a triple click.",
      effect: "change",
      web: true,
    },
    { sessionId, ...point, selector: z.string().optional(), button: z.enum(["left", "right", "middle"]).optional(), count: z.number().int().min(1).max(3).optional() },
    (a) => input(a.sessionId, { action: "click", selector: a.selector, x: a.x, y: a.y, button: a.button, count: a.count as 1 | 2 | 3 | undefined }),
  );

  tool(
    "mouse_drag",
    {
      title: "Drag with the mouse",
      description: "Drag with the left button held: from a selector or fromX/fromY to a selector or toX/toY (e.g. a slider handle or a list item), or along path (up to 200 {x, y} points).",
      effect: "change",
      web: true,
    },
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

  tool(
    "hover",
    { title: "Hover", description: "Move the pointer over a selector or to x/y, e.g. to open a menu that shows on hover.", effect: "change", web: true },
    { sessionId, selector: z.string().optional(), ...point },
    (a) => input(a.sessionId, { action: "hover", selector: a.selector, x: a.x, y: a.y }),
  );

  tool(
    "key",
    { title: "Press a key combination", description: "Press a key combination, e.g. Control+A, Shift+Tab, Meta+C (or one key: Enter, Escape, ArrowDown).", effect: "change", web: true },
    { sessionId, keys: z.string() },
    (a) => input(a.sessionId, { action: "key", keys: a.keys }),
  );

  tool(
    "computer",
    {
      title: "Run a computer-use action",
      description:
        "Run ONE computer-use action as a model's computer tool gives it, in Anthropic's shape ({action:'left_click', coordinate:[x, y]}) or OpenAI's ({type:'click', x, y, button}), " +
        "then see the screen. Coordinates are pixels of the screenshot; with maxWidth the screenshot is scaled down and coordinates are scaled back.",
      effect: "change",
      web: true,
    },
    { sessionId, action: z.record(z.string(), z.unknown()).describe("The provider's action object"), maxWidth: z.number().int().min(100).max(3840).optional(), screenshot: z.boolean().optional() },
    async (a) => {
      const s = await machine(a.sessionId);
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

  tool("browser_screenshot", { title: "Screenshot the page", description: "Screenshot the current tab.", effect: "read", web: true }, { sessionId, fullPage: z.boolean().optional() }, async (a) => {
    const shot = await (await machine(a.sessionId, false)).screenshot({ format: "jpeg", quality: 60, fullPage: a.fullPage });
    return { content: [{ type: "image" as const, data: shot.data, mimeType: shot.mimeType }] };
  });

  tool("browser_read", { title: "Read the page", description: "Read the current page as markdown or plain text.", effect: "read", web: true }, { sessionId, format: z.enum(["markdown", "text"]).optional() }, async (a) => {
    const v = await (await machine(a.sessionId, false)).content(a.format ?? "markdown");
    return text(`# ${v.title}\n${v.url}\n\n${v.content}`);
  });

  // ---------- shell and files ----------

  tool(
    "run_command",
    {
      title: "Run a shell command",
      description: "Run a bash command in the session's persistent shell (cd and export persist). Working directory starts at the workspace; browser downloads are in ./downloads.",
      effect: "destroy",
      web: true,
    },
    { sessionId, command: z.string(), timeoutMs: z.number().optional() },
    async (a) => {
      const r = await (await machine(a.sessionId)).exec(a.command, { timeoutMs: a.timeoutMs ?? 120_000 });
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)";
      return text(`${out}\n[exit code ${r.exitCode ?? "timeout"}]`);
    },
  );

  tool(
    "run_playwright",
    {
      title: "Run Playwright code",
      description:
        "Run Playwright JavaScript inside the session's sandbox, next to its browser. `page`, `context`, `browser` and `env` are in scope; top-level await works; a returned value is printed. Do not call browser.close(). `step(instruction)` and `extract(instruction, schema?)` use the call's own {provider, model}, else the last `useModel(model)` / `useModel(provider, model)` in the code, else `ai`.",
      effect: "destroy",
      web: true,
    },
    {
      sessionId,
      code: z.string(),
      env: z.record(z.string(), z.string()).optional(),
      timeoutMs: z.number().optional(),
      ai: z.object({ provider: z.enum(["anthropic", "openai", "xai", "google"]).optional(), model: z.string().optional() }).optional(),
    },
    async (a) => {
      const r = await (await machine(a.sessionId)).runScript(a.code, { env: a.env, timeoutMs: a.timeoutMs ?? 120_000, ai: a.ai });
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)";
      return { ...text(`${out}\n[exit code ${r.exitCode ?? "timeout"}]`), ...(r.exitCode === 0 ? {} : { isError: true }) };
    },
  );

  tool("list_files", { title: "List files", description: "List files in the session workspace.", effect: "read", web: false }, { sessionId, path: z.string().optional() }, async (a) => {
    const r = await (await machine(a.sessionId, false)).files.list(a.path ?? ".");
    return text(r.entries.map((e) => `${e.type === "dir" ? "d" : "-"} ${String(e.size).padStart(10)}  ${e.name}`).join("\n") || "(empty)");
  });

  tool("read_file", { title: "Read a file", description: "Read a text file from the session workspace.", effect: "read", web: false }, { sessionId, path: z.string() }, async (a) => {
    return text(await (await machine(a.sessionId, false)).files.readText(a.path));
  });

  tool(
    "write_file",
    { title: "Write a file", description: "Write a text file into the session workspace. An existing file at that path is overwritten.", effect: "destroy", web: false },
    { sessionId, path: z.string(), content: z.string() },
    async (a) => {
      const r = await (await machine(a.sessionId)).files.write(a.path, a.content);
      return text(`Wrote ${r.size} bytes to ${r.path}.`);
    },
  );

  // ---------- no session needed ----------

  tool(
    "fetch_url",
    {
      title: "Fetch a web page",
      description: "Fetch a web page through a real browser and return markdown, HTML or text (no session needed). blockAds: refuse ad and tracker sites while loading it.",
      effect: "read",
      web: true,
    },
    { url: z.string(), format: z.enum(["markdown", "html", "text"]).optional(), blockAds: z.boolean().optional() },
    async (a) => {
      const settings: BrowserSettings = { blockAds: a.blockAds };
      const opts = { format: a.format ?? "markdown", ...settings };
      const r = await client.fetch(a.url, opts);
      return text(`# ${r.title}\n${r.finalUrl} (HTTP ${r.status})\n\n${r.content}`);
    },
  );

  tool(
    "web_search",
    {
      title: "Search the web",
      description:
        "Search the web (no session needed). Returns titles, URLs and snippets of the top results; open one with browser_navigate or fetch_url. " +
        "Set fetch to also get the top 1 to 5 pages as Markdown in the same call. Each search counts against the plan's monthly searches (the same search within an hour is free).",
      effect: "read",
      web: true,
    },
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

  return server;
}
