# Boxline MCP server

**Give your AI agents the infrastructure they need: browsers, shells, storage and isolated machines.**

This server gives any MCP client (Claude, Cursor, VS Code and others) an isolated cloud machine with a real browser, a shell and
a disk, through [Boxline](https://boxline.dev). The agent can open pages, click and type, read a page as Markdown,
run commands, read and write files, fetch pages and search the web.

## Set it up

You need a Boxline API key (console → API keys) and Node 20 or newer.

Claude Desktop, Cursor and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "boxline": {
      "command": "npx",
      "args": ["-y", "@boxline/mcp"],
      "env": { "BOXLINE_API_KEY": "bxl_your_key" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add boxline --env BOXLINE_API_KEY=bxl_your_key -- npx -y @boxline/mcp
```

`BOXLINE_API_URL` points it at another API (default `https://api.boxline.dev`).

## Tools

The server keeps nothing between calls: `session_create` returns a `sessionId`, and every tool that works in a session
takes it as a required `sessionId` (a tool that acts resumes a stopped session first, as it was; the read-only ones,
`browser_read`, `browser_screenshot`, `list_files` and `read_file`, say to call `session_resume` instead). `fetch_url`, `web_search`, `screenshot_url`,
`crawl_site`, `crawl_results` and `extract_data` need no session.

Every tool says what it does to the world in its MCP annotations (a title, and read-only, destructive and open-world
hints), so a client can decide what to ask you about.

| Group | Tools |
|---|---|
| Sessions | `session_create` (optionally from a saved browser `profile`, and with `credentials` exported into the shell), `session_stop` (saves the session as it is and stops billing), `session_resume` (brings a stopped session back as it was), `session_delete` (deletes it and what it saved, for good), `session_move` (to a fresh machine, keeping tabs, logins and files) |
| Browser | `browser_navigate`, `browser_click`, `browser_type` (text, or a saved credential), `browser_login` (sign in with a saved password), `browser_press`, `browser_read` (Markdown or text), `browser_screenshot` |
| Credentials | `credentials_list` (names, types, sites and a password's code source for the saved passwords and secrets, never their values) |
| Mouse and keyboard | `mouse_move`, `mouse_click`, `mouse_drag`, `hover`, `key`, `computer` (screenshot-driven computer use) |
| Shell and code | `run_command` (bash in the session), `run_playwright` (Playwright code next to the browser) |
| Files | `list_files`, `read_file`, `write_file`, `delete_file` (the session's workspace, its disk) |
| Web | `fetch_url` (a page through a real browser), `web_search` (with the top pages as Markdown), `screenshot_url` (a quick screenshot); none needs a session |
| Crawl and scrape | `crawl_site` and `crawl_results` (a whole site or section, robots.txt respected, up to 200 pages), `extract_data` (JSON from up to 10 pages, from a prompt or a JSON Schema); no session needed |

### Signing in without showing the agent a password

Save a website password (or a secret) as a **credential** in the Boxline console, the [CLI](https://www.npmjs.com/package/@boxline/cli) or an SDK.
The agent calls `credentials_list` to see what exists (names, types and the sites each may be typed on; never a value), then
types it with `browser_type`:

```
browser_type { "sessionId": "<id>", "credential": "SHOP", "field": "username", "selector": "#email" }
browser_type { "sessionId": "<id>", "credential": "SHOP", "field": "password", "selector": "#password" }
browser_type { "sessionId": "<id>", "credential": "SHOP", "field": "otp", "selector": "#code" }   // the current 2FA code, if the password has a 2FA key
```

Or sign in in one call with `browser_login { "sessionId": "<id>", "credential": "SHOP", "url": "https://shop.example.com/login" }`: a short run in the
session types the credential on its sites only, and the agent sees neither the password nor any code. A password whose
`codeSource` (in `credentials_list`) is `push` or `url` waits for the code or sign-in link that your system sends, up to its
timeout (the agent should tell you a code is needed); you send it with the CLI (`boxline credentials push-code SHOP`) or
an SDK (`credentials.pushCode`), never through the chat.

The platform types the value into the field itself, only on the sites the credential was saved for, and never shows it to
the agent, the chat or the logs: wherever a result would show it (`browser_read`, the page's elements, a screenshot, an
error), the text is replaced by `%SHOP.password%` and the field is covered. **This hides a value; it does not protect
it.** It is a guard against showing a credential by accident, not a boundary: code that runs in the page or the session
(`run_playwright`, a command in `run_command`) can still read a field and print it, for example reversed or in base64. Use a
password only in sessions whose pages and scripts you trust, and save it with the narrowest sites. `session_create` can also start from a saved browser `profile` (cookies and logins from an
earlier sign-in; `persistProfile` saves new ones back) and export `credentials` into the session's shell as environment
variables, for those credentials that allow it. No tool creates or changes a credential, so a password never passes
through the chat: add them yourself, outside the conversation.

Sessions are billed while they run: stop them with `session_stop` when the work is done, or let them stop at their time
limit. A stopped session is free and is kept for your plan's retention days (7 on Free, 30 on Hobby and Startup, 90 on
Scale): `session_resume` brings it back with its tabs and files, and `session_delete` removes it at once, with its
recording and logs. A tool that acts, given the id of a stopped session, resumes it first; a read-only tool says to call `session_resume`.

## Self-hosting over HTTP

`boxline-mcp --http` serves the same tools over HTTP at `POST /mcp`, for clients that connect to a URL instead of starting a
process. It speaks the MCP revision 2026-07-28 and, without sessions, the 2025-era protocol older clients still use.

```bash
MCP_ALLOWED_HOSTS=mcp.example.com BOXLINE_API_URL=https://api.boxline.dev npx -y @boxline/mcp --http
```

- **Sign-in:** every request carries its own Boxline API key as `Authorization: Bearer <API key>`, or the OAuth access token an
  MCP client got when a person clicked "Connect" (below). The server holds no key of its own, never logs a token, and calls the
  API with the token of the request it is serving. Before a request is served the token is checked against the API
  (one `GET /v1/auth/me`, remembered for a minute by its hash): a token the API refuses (expired, revoked, unknown) is `401`, so a client
  signs in again or refreshes it instead of getting a tool error. Without a token the answer is `401` with `WWW-Authenticate: Bearer`.
- **OAuth sign-in** (for ChatGPT, Claude and other clients that offer "Connect" instead of a key field) is for **Boxline's hosted
  server**, `https://mcp.boxline.dev/mcp`. Boxline's sign-in issues tokens for that address only. A server you host yourself takes
  API keys (`Authorization: Bearer bxl_…`). The hosted server sets `MCP_RESOURCE` (its public URL) and `MCP_AUTH_SERVER` (the issuer,
  `https://api.boxline.dev`), then publishes protected resource metadata
  (`/.well-known/oauth-protected-resource`, RFC 9728) and answers a missing or refused token with `401` and a
  `WWW-Authenticate: Bearer resource_metadata="…"` challenge, which is what those clients follow to sign the person in. An OAuth token
  (`bxo_…`) always gets the `directory` tools (no saved credentials); a `bxl_` API key gets `MCP_TOOLS`.
- **Stateless:** each request is served on its own, so any number of copies behind a load balancer can answer any request,
  and a restart loses nothing. Nothing is remembered between calls: the `sessionId` that `session_create` returns is
  the only handle (as above). `GET /mcp` and `DELETE /mcp` answer `405`.
- **Put it behind HTTPS** (a reverse proxy or load balancer). `GET /healthz` answers `200 ok` for health checks, on any host.
- **Environment:**

| Variable | Default | |
|---|---|---|
| `MCP_PORT` | `8081` | Port to listen on (`0` picks a free one). |
| `MCP_HOST` | `0.0.0.0` | Address to bind. |
| `BOXLINE_API_URL` | `https://api.boxline.dev` | The Boxline API the server calls. |
| `MCP_ALLOWED_HOSTS` | none | Comma-separated host names the server answers to (`mcp.example.com`), against DNS rebinding. `localhost`, `127.0.0.1` and `[::1]` always pass; `*` turns the host and origin checks off. A request whose `Host` is not listed gets `403`, and so does a browser `Origin` that is not one of them. |
| `MCP_RESOURCE`, `MCP_AUTH_SERVER` | none | Both or neither: turn on OAuth sign-in discovery (above; Boxline's hosted server only). |
| `MCP_OPENAI_CHALLENGE` | none | The token ChatGPT's domain verification expects at `/.well-known/openai-apps-challenge`. |
| `MCP_TOKEN_CACHE_SECONDS` | `60` | How long a token's check against the API is remembered (`0`: every request). |
| `MCP_TOOLS` | `full` | `directory` leaves out `browser_login`, `credentials_list` and every credential parameter (`credential` and `field` on `browser_type`, `credentials` on `session_create`): for a server listed in a public connector directory. |

Request bodies are limited to 4 MiB (`413`), and at most 32 requests run at once (`MCP_MAX_IN_FLIGHT`; more get `503`). Live view URLs are left out of tool results. Long tool calls keep their connection alive with SSE comment frames every 15 seconds.

## Links

- Docs: [docs.boxline.dev](https://docs.boxline.dev)
- Node SDK: [Boxline-dev/sdk-node](https://github.com/Boxline-dev/sdk-node) · Python SDK: [Boxline-dev/sdk-python](https://github.com/Boxline-dev/sdk-python)

MIT licence.

---

This repository holds the Boxline MCP server (@boxline/mcp). It is copied from Boxline's main repository on every change. Issues and pull requests are welcome here; accepted changes are made there and arrive with the next copy.
