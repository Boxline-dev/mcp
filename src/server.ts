/**
 * The Boxline MCP server: one function that builds a server around a Boxline client. The stdio entry builds it once
 * per connection; the HTTP entry builds one per request, around that request's own API key. It keeps no state between
 * calls: `session_create` returns a session id and every tool that needs a machine takes it as `sessionId` (a stopped
 * session is resumed first, as it was).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { Boxline, BoxlineError, CredentialLoginFailedError, type ActionItem, type ActionResult, type ComputerAction, type Session, type SessionStatus } from "@boxline/sdk";
import { z } from "zod";
import { VERSION } from "./version.js";

/** `full`: every tool. `directory`: no saved-credential tools and no credential parameters (for public connector directories). */
export type ToolSetting = "full" | "directory";

export interface ServerOptions {
  tools?: ToolSetting;
  /** Whether session_create and session_resume return the signed live view URL (a bearer link that controls the browser). Off when hosted. Default true. */
  liveUrls?: boolean;
  /**
   * Whether the tools say they sign in with OAuth (the hosted server, when it offers OAuth): every tool declares
   * `securitySchemes: [{type: "oauth2", scopes: ["boxline"]}]` in `_meta`, the form OpenAI's apps read (the MCP SDK has no field for it).
   */
  oauth?: boolean;
}

const TEXT_LIMIT = 40_000;
/** A crawl answer holds this many pages, each cut at this many characters, so it fits TEXT_LIMIT. */
const CRAWL_PAGES_PER_CALL = 10;
const CRAWL_PAGE_CHARS = 3_500;
/** What browser_act shows of one step's value (an evaluate result, extracted data), so many steps fit TEXT_LIMIT. */
const ACTION_VALUE_CHARS = 8_000;

const INSTRUCTIONS =
  "Boxline gives you an isolated cloud machine: a Chrome browser, a bash shell and a /workspace disk (a session is a browser, a shell or both). " +
  "Call session_create first and pass the sessionId it returns to every other session tool; session_list finds an id again. " +
  "web_fetch, web_search, web_screenshot, web_extract and the web_crawl tools need no session. Call session_stop when you are done: billing stops and session_resume brings the session back as it was.";

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
        ...(opts.oauth ? { _meta: { securitySchemes: [{ type: "oauth2", scopes: ["boxline"] }] } } : {}),
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
   * for the read-only browser tools (browser_read, browser_screenshot), which say so instead; anything else the API refuses
   * says so. The file tools files_list and files_read do not use this: they read a stopped session's saved files directly.
   */
  async function machine(id: string, resume = true): Promise<Session> {
    const s = await client.sessions.get(id);
    if (s.status !== "STOPPED") return s;
    if (!resume) throw new Error(`session ${id} is stopped: call session_resume to start it again, then retry`);
    return s.resume();
  }

  const sessionId = z.string().min(1).describe("Id of the session, from session_create");

  /** Why an action did not work, with its code when the API gave one. */
  const why = (r: ActionResult | undefined) => (r?.code ? `${r.code}: ${r.error ?? "the action failed"}` : (r?.error ?? "the action failed"));

  /**
   * What an action found, after its line: the value of `evaluate`, the data of `extract`, the numbered elements of
   * `elements` and the tabs of `tabs` (the line alone says "Ran the expression"). The other actions say all they have to say.
   */
  const shown = (r: ActionResult): string => {
    const v = r.value as { elements?: string; data?: unknown; tabs?: unknown } | undefined;
    if (v === undefined || v === null) return "";
    const body = r.action === "evaluate" ? (typeof v === "string" ? v : JSON.stringify(v)) : r.action === "extract" ? JSON.stringify(v.data) : r.action === "elements" ? (v.elements ?? "") : r.action === "tabs" ? JSON.stringify(v.tabs) : "";
    if (!body) return "";
    return `\n${body.length > ACTION_VALUE_CHARS ? `${body.slice(0, ACTION_VALUE_CHARS)}\n[… cut at ${ACTION_VALUE_CHARS} characters]` : body}`;
  };

  // ---------- sessions ----------

  tool(
    "session_create",
    {
      title: "Create a session",
      description:
        "Create a new isolated session: a Chrome browser, a bash shell or both, and a shared /workspace disk. Returns its sessionId: pass it to every other session tool. " +
        "browser (default true) and shell (default true) choose the kind: browser: false with a shell is a shell-only session (no live view; the browser_* tools are refused). " +
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
      browser: z.boolean().optional().describe("Give the session a browser (default true). false needs a shell: a shell-only session"),
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
      if (a.persistProfile && !a.profile) throw new Error("persistProfile needs a profile id");
      const profile = a.profile ? { id: a.profile, persist: a.persistProfile ?? false } : undefined;
      const credentials = full && a.credentials?.length ? a.credentials : undefined;
      const timeout = a.timeout ?? (await defaultTimeout());
      const browser = a.browser ?? true;
      const params = { browser, shell: a.shell ?? true, timeout, proxy, profile, credentials, blockAds: a.blockAds, cookieBanners: a.cookieBanners };
      let s: Session;
      try {
        s = await client.sessions.create(params);
      } catch (err) {
        // No shells here (a plan without them, or a local API that doesn't allow them), none was asked for and the session
        // has a browser: a browser-only session still serves every browser, file and web tool. A shell-only session has
        // nothing to fall back to: the real error is the answer.
        if (a.shell !== undefined || !browser || !/shell/i.test(err instanceof Error ? err.message : String(err))) throw err;
        s = await client.sessions.create({ ...params, shell: false, credentials: undefined });
      }
      return text(JSON.stringify({ sessionId: s.id, ...live(s), workspace: s.workspacePath, shell: s.data.shell }, null, 2));
    },
  );

  tool(
    "session_list",
    {
      title: "List sessions",
      description:
        "List the project's sessions, newest first: id, status (RUNNING, STOPPED, DELETED, ERROR), kind (browser, shell or combined) and when it was created. " +
        "Use it to find a session id again. Filter by status (several joined with commas, e.g. RUNNING,STOPPED), kind, or q (an id prefix or text in the session's userMetadata); " +
        "limit (1 to 100, default 20); when there are more, the last line gives the after to pass to read the next ones. Stopped sessions are listed too: session_resume brings one back.",
      effect: "read",
      web: false,
    },
    {
      status: z.string().optional().describe("Only these statuses, comma-separated: RUNNING, STOPPED, DELETED, ERROR"),
      kind: z.enum(["browser", "shell", "combined"]).optional(),
      q: z.string().optional().describe("An id prefix, or text in the session's userMetadata"),
      limit: z.number().int().min(1).max(100).optional().describe("How many sessions, 1 to 100 (default 20)"),
      after: z.string().optional().describe("The cursor from the last line of the previous answer"),
    },
    async (a) => {
      const statuses = a.status
        ?.split(",")
        .map((v) => v.trim().toUpperCase())
        .filter(Boolean) as SessionStatus[] | undefined;
      const bad = statuses?.find((v) => !["RUNNING", "STOPPED", "DELETED", "ERROR"].includes(v));
      if (bad) throw new Error(`status ${bad} is not one of RUNNING, STOPPED, DELETED, ERROR`);
      const page = await client.sessions.list({ status: statuses?.length ? statuses : undefined, kind: a.kind, q: a.q, limit: a.limit ?? 20, after: a.after });
      const kind = (s: Session) => (s.data.shell ? (s.data.browser === false ? "shell" : "combined") : "browser");
      const rows = page.data.map((s) => `${s.id}  ${String(s.status).padEnd(7)}  ${kind(s).padEnd(8)}  ${s.data.createdAt}`);
      if (!rows.length) return text("No sessions.");
      if (page.next) rows.push(`More sessions: call session_list again with after "${page.next}".`);
      return text(rows.join("\n"));
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

  // ---------- browser (a session with a browser: the API answers browser_disabled to a shell-only one) ----------

  tool("browser_navigate", { title: "Open a URL", description: "Open a URL in the session's browser.", effect: "change", web: true }, { sessionId, url: z.string() }, async (a) => {
    const v = await (await machine(a.sessionId)).goto(a.url);
    return text(`Loaded ${v.url} (HTTP ${v.status ?? "?"}) — ${v.title}`);
  });

  tool(
    "browser_act",
    {
      title: "Do steps in the browser",
      description:
        "Do one or more steps on the session's browser page, in order, and stop at the first one that fails. Each step is a sentence in plain English (\"click the Sign in link\", \"scroll to the pricing table\") " +
        "or an exact action object such as {\"action\": \"click\", \"selector\": \"text=Sign in\"}, {\"action\": \"hover\", \"selector\": \"text=Products\"}, {\"action\": \"goto\", \"url\": \"https://example.com\"}, " +
        "{\"action\": \"scroll\", \"deltaY\": 600}, {\"action\": \"evaluate\", \"expression\": \"document.title\"}, {\"action\": \"click\", \"selector\": \"#file\", \"button\": \"right\"} or {\"action\": \"drag\", \"from\": {\"x\": 10, \"y\": 10}, \"to\": {\"x\": 200, \"y\": 10}}. " +
        "A plain-English step is carried out by a model (like a step of an agent run: it is billed as one and needs a plan that includes plain-English steps); an action object uses no model. " +
        "Use it to do several things in one call, or when saying what to click is easier than finding its selector. Coordinates are CSS pixels of the viewport. Returns one line per step saying what happened; an evaluate step also gives the value it returned, extract the data, elements the page's numbered elements.",
      effect: "change",
      web: true,
    },
    {
      sessionId,
      actions: z
        .array(z.union([z.string().min(1).max(2000), z.looseObject({ action: z.string() })]))
        .min(1)
        .max(100)
        .describe("The steps, 1 to 100: a plain-English sentence, or an action object with an `action` field"),
    },
    async (a) => {
      if (!full) {
        // The directory setting never takes saved credentials: not as a step's credentials, not as a type or login action.
        const named = a.actions.find((x) => typeof x !== "string" && (x.action === "login" || "credential" in x || "credentials" in x));
        if (named) throw new Error("that action is not available on this server");
      }
      const s = await machine(a.sessionId);
      const results = await s.actions(a.actions as ActionItem[]);
      const lines = results.map((r, i) => `${i + 1}. ${r.ok ? `${r.text ?? `${r.action} done`}${shown(r)}` : `Failed: ${why(r)}`}`);
      const ok = results.every((r) => r.ok);
      return { ...text(lines.join("\n") || "(no steps)"), ...(ok ? {} : { isError: true }) };
    },
  );

  tool(
    "browser_click",
    {
      title: "Click an element",
      description:
        "Click an element (Playwright selector such as `text=Sign in` or `#submit`) or at page coordinates x and y. For a right or double click, or a click with a key held, use browser_act with a click action.",
      effect: "change",
      web: true,
    },
    { sessionId, selector: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
    async (a) => {
      if (a.selector === undefined && (a.x === undefined || a.y === undefined)) return fail("give a selector, or x and y");
      const [r] = await (await machine(a.sessionId)).actions({ action: "click", selector: a.selector, x: a.x, y: a.y });
      return r?.ok ? text("Clicked.") : fail(why(r));
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
      return fail(why(r));
    },
  );

  tool(
    "browser_press",
    {
      title: "Press keys",
      description:
        "Press keys on the session's browser page: one key (Enter, Escape, ArrowDown, Tab), a combination held together with + (Control+A, Shift+Tab, Meta+C), or several combinations one after the other separated by spaces (\"ctrl+a Delete\"). " +
        "Key names are Playwright's; common spellings such as ctrl, cmd and Return work too, and a capital letter is typed with Shift. The machines run Linux: select-all is Control+A (ControlOrMeta+A works everywhere). " +
        "The keys go to the page, never to the machine's desktop.",
      effect: "change",
      web: true,
    },
    { sessionId, keys: z.string().min(1).describe("The keys: Enter, Control+A, or several separated by spaces") },
    async (a) => {
      const [r] = await (await machine(a.sessionId)).actions({ action: "key", keys: a.keys });
      return r?.ok ? text(r.text ?? `Pressed ${a.keys}`) : fail(why(r));
    },
  );

  tool("browser_read", { title: "Read the page", description: "Read the current page as markdown or plain text.", effect: "read", web: true }, { sessionId, format: z.enum(["markdown", "text"]).optional() }, async (a) => {
    const v = await (await machine(a.sessionId, false)).content(a.format ?? "markdown");
    return text(`# ${v.title}\n${v.url}\n\n${v.content}`);
  });

  tool("browser_screenshot", { title: "Screenshot the page", description: "Screenshot the current tab.", effect: "read", web: true }, { sessionId, fullPage: z.boolean().optional() }, async (a) => {
    const shot = await (await machine(a.sessionId, false)).screenshot({ format: "jpeg", quality: 60, fullPage: a.fullPage });
    return { content: [{ type: "image" as const, data: shot.data, mimeType: shot.mimeType }] };
  });

  if (full) {
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

  tool(
    "browser_computer",
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
      const r = await s.computer(a.action as unknown as ComputerAction, { maxWidth: a.maxWidth, screenshot: a.screenshot });
      const summary = `${r.ok ? r.text : `Failed: ${r.error}`}\nPointer: (${r.cursor.x}, ${r.cursor.y}) · scale ${r.scale} · ${r.title} — ${r.url}`;
      return {
        ...(r.ok ? {} : { isError: true }),
        content: [{ type: "text" as const, text: summary }, ...(r.screenshot ? [{ type: "image" as const, data: r.screenshot, mimeType: r.mimeType ?? "image/png" }] : [])],
      };
    },
  );

  // ---------- shell and files ----------

  tool(
    "shell_exec",
    {
      title: "Run a shell command",
      description:
        "Run a bash command in the session's persistent shell (cd and export persist). Working directory starts at the workspace; browser downloads are in ./downloads. Needs a session with a shell. " +
        "For a job longer than timeoutMs, start it in the background (`nohup … > job.log 2>&1 &`) and read job.log later with files_read.",
      effect: "destroy",
      web: true,
    },
    { sessionId, command: z.string(), timeoutMs: z.number().int().min(100).max(3_600_000).optional() },
    async (a) => {
      const r = await (await machine(a.sessionId)).exec(a.command, { timeoutMs: a.timeoutMs ?? 120_000 });
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)";
      return text(`${out}\n[exit code ${r.exitCode ?? "timeout"}]`);
    },
  );

  // The two read-only file tools work on a stopped session too: the API serves its saved workspace without starting a machine.
  tool(
    "files_list",
    { title: "List files", description: "List files in the session workspace. A stopped session's saved files are listed without resuming it.", effect: "read", web: false },
    { sessionId, path: z.string().optional() },
    async (a) => {
      const r = await client.sessions.files.list(a.sessionId, a.path ?? ".");
      return text(r.entries.map((e) => `${e.type === "dir" ? "d" : "-"} ${String(e.size).padStart(10)}  ${e.name}`).join("\n") || "(empty)");
    },
  );

  tool(
    "files_read",
    { title: "Read a file", description: "Read a text file from the session workspace. A stopped session's saved files are read without resuming it.", effect: "read", web: false },
    { sessionId, path: z.string() },
    async (a) => text(await client.sessions.files.readText(a.sessionId, a.path)),
  );

  tool(
    "files_write",
    { title: "Write a file", description: "Write a text file into the session workspace. An existing file at that path is overwritten.", effect: "destroy", web: false },
    { sessionId, path: z.string(), content: z.string() },
    async (a) => {
      const r = await (await machine(a.sessionId)).files.write(a.path, a.content);
      return text(`Wrote ${r.size} bytes to ${r.path}.`);
    },
  );

  tool(
    "files_delete",
    { title: "Delete a file", description: "Delete a file from the session workspace. It cannot be brought back.", effect: "destroy", web: false },
    { sessionId, path: z.string() },
    async (a) => {
      await (await machine(a.sessionId)).files.delete(a.path);
      return text(`Deleted ${a.path}.`);
    },
  );

  // ---------- the web: no session needed ----------

  tool(
    "web_fetch",
    {
      title: "Fetch a web page",
      description: "Fetch a web page through a real browser and return markdown, HTML or text (no session needed). blockAds: refuse ad and tracker sites while loading it.",
      effect: "read",
      web: true,
    },
    { url: z.string(), format: z.enum(["markdown", "html", "text"]).optional(), blockAds: z.boolean().optional() },
    async (a) => {
      const r = await client.fetch(a.url, { format: a.format ?? "markdown", blockAds: a.blockAds });
      return text(`# ${r.title}\n${r.finalUrl} (HTTP ${r.status})\n\n${r.content}`);
    },
  );

  tool(
    "web_search",
    {
      title: "Search the web",
      description:
        "Search the web (no session needed). Returns titles, URLs and snippets of the top results; open one with browser_navigate or web_fetch. " +
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
      const r = await client.search({ query: a.query, limit: a.limit, country: a.country, language: a.language, recency: a.recency, fetch: a.fetch || undefined });
      if (!r.results.length) return text(`No results for "${r.query}".`);
      const lines = r.results.map((x, i) => {
        const head = `${i + 1}. ${x.title}\n   ${x.url}${x.publishedAt ? ` (${x.publishedAt.slice(0, 10)})` : ""}\n   ${x.snippet}`;
        if (x.error) return `${head}\n   [could not load the page: ${x.error.code}: ${x.error.message}]`;
        return x.content ? `${head}\n\n${x.content}\n` : head;
      });
      return text(`Search results for "${r.query}"${r.cached ? " (cached)" : ""}:\n\n${lines.join("\n\n")}`);
    },
  );

  tool(
    "web_screenshot",
    {
      title: "Screenshot a web page",
      description: "Take a screenshot of a web page in a fresh browser (no session needed). fullPage captures the whole page instead of the first screen. To see the page a session is on, use browser_screenshot.",
      effect: "read",
      web: true,
    },
    { url: z.string(), fullPage: z.boolean().optional() },
    async (a) => {
      const bytes = await client.screenshot(a.url, { format: "jpeg", quality: 60, fullPage: a.fullPage });
      return { content: [{ type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: "image/jpeg" }] };
    },
  );

  tool(
    "web_extract",
    {
      title: "Extract data from pages",
      description:
        "Read up to 10 pages in a real browser and return the data asked for as JSON (no session needed): give url or urls, and a prompt saying what to collect " +
        "or a JSON Schema for exact fields. A page that does not show a value gives null, never a guess. Uses a model, billed like other model calls. Public pages only.",
      effect: "read",
      web: true,
    },
    {
      url: z.string().optional(),
      urls: z.array(z.string()).min(1).max(10).optional(),
      prompt: z.string().max(4000).optional().describe("What to collect, in words"),
      schema: z.record(z.string(), z.unknown()).optional().describe("A JSON Schema the result must match"),
    },
    async (a) => {
      if (!a.url && !a.urls?.length) throw new Error("give url or urls");
      if (!a.prompt && !a.schema) throw new Error("give a prompt or a schema");
      const r = await client.extract({ url: a.url, urls: a.urls, prompt: a.prompt, schema: a.schema });
      const pages = r.pages.map((pg) => `- ${pg.finalUrl ?? pg.url}: ${pg.error ? `not read (${pg.error.code}: ${pg.error.message})` : `HTTP ${pg.status}`}`);
      return text(`${JSON.stringify(r.data, null, 2)}\n\nPages:\n${pages.join("\n")}`);
    },
  );

  /** A crawl and one page of its pages, as text: how far it got, then each page (its content capped so many fit). */
  async function crawlReport(id: string, after?: string): Promise<string> {
    const job = await client.crawl.get(id, { limit: CRAWL_PAGES_PER_CALL, after });
    const head =
      `Crawl ${job.id} of ${job.url}: ${job.status}; ${job.pagesDone} pages read, ${job.pagesFailed} failed, ${job.skippedByRobots} skipped by robots.txt.` +
      (job.error ? ` Error: ${job.error}` : "");
    const pages = job.data.map((pg) => {
      const where = `${pg.finalUrl ?? pg.url} (${pg.status === null ? "no answer" : `HTTP ${pg.status}`}, depth ${pg.depth})`;
      if (pg.error) return `## ${pg.title ?? pg.url}\n${where}\nFailed: ${pg.error}`;
      if (pg.captcha) return `## ${pg.title ?? pg.url}\n${where}\nThe page showed a CAPTCHA (${pg.captcha}); it was not read.`;
      const body = pg.content ?? "";
      return `## ${pg.title ?? pg.url}\n${where}\n\n${body.length > CRAWL_PAGE_CHARS ? `${body.slice(0, CRAWL_PAGE_CHARS)}\n[… page cut at ${CRAWL_PAGE_CHARS} characters]` : body}`;
    });
    const more =
      job.next ? `More pages: call web_crawl_get with crawlId "${job.id}" and after "${job.next}".`
      : job.status === "running" ? `The crawl is still running: call web_crawl_get with crawlId "${job.id}"${after ? ` and after "${after}"` : ""} in a few seconds.`
      : "That is every page.";
    return [head, ...pages, more].join("\n\n");
  }

  tool(
    "web_crawl_start",
    {
      title: "Crawl a website",
      description:
        "Crawl a website from a start URL (no session needed): follow its links, read each page in a real browser and return the pages as markdown, text or HTML. " +
        "Respects robots.txt and stays on the start page's host unless sameHost is false. Waits up to waitSeconds (default 45) and returns the pages read so far; " +
        "while it is still running, web_crawl_get gives the rest. Public pages only.",
      effect: "change",
      web: true,
    },
    {
      url: z.string(),
      maxPages: z.number().int().min(1).max(1000).optional().describe("Pages to read, 1 to 1000 (default 20; the plan's crawl limit applies)"),
      maxDepth: z.number().int().min(0).max(10).optional().describe("Link depth from the start page, 0 to 10 (default 3)"),
      include: z.array(z.string()).max(20).optional().describe("Only follow URLs that match one of these regular expressions"),
      exclude: z.array(z.string()).max(20).optional().describe("Never follow URLs that match one of these regular expressions"),
      sameHost: z.boolean().optional().describe("Stay on the start page's host (default true)"),
      format: z.enum(["markdown", "text", "html"]).optional(),
      waitSeconds: z.number().int().min(0).max(120).optional().describe("How long to wait for the crawl before answering (default 45)"),
    },
    async (a) => {
      let job = await client.crawl.start({ url: a.url, maxPages: a.maxPages, maxDepth: a.maxDepth, include: a.include, exclude: a.exclude, sameHost: a.sameHost, format: a.format ?? "markdown" });
      const until = Date.now() + (a.waitSeconds ?? 45) * 1000;
      while (job.status === "running" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2000));
        job = await client.crawl.get(job.id, { limit: 0 });
      }
      return text(await crawlReport(job.id));
    },
  );

  tool(
    "web_crawl_get",
    {
      title: "Get a crawl's pages",
      description: `The state of a crawl started with web_crawl_start and its next pages (${CRAWL_PAGES_PER_CALL} at a time; pass the after it gives to go on). It only reads.`,
      effect: "read",
      web: false,
    },
    { crawlId: z.string().min(1), after: z.string().optional() },
    async (a) => text(await crawlReport(a.crawlId, a.after)),
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
  }

  return server;
}
