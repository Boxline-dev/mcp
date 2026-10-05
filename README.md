# Boxline MCP server

**Give your AI agents the infrastructure they need: browsers, shells, storage and isolated machines.**

This server gives any MCP client (Claude, Cursor, VS Code and others) an isolated cloud machine with a real browser, a shell and
a disk, through [Boxline](https://boxline.dev). The agent can open pages, click and type, read a page as Markdown,
run commands, read and write files, fetch pages and search the web.

## Set it up

You need a Boxline API key (console → API keys) and Node 18 or newer.

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

Every tool takes an optional `sessionId`. Without one, the server uses its current session, or starts one (a browser
and, when the plan has them, a shell), so an agent can call `browser_navigate` and start working.

| Group | Tools |
|---|---|
| Sessions | `session_create` (optionally from a saved browser `profile`, and with `credentials` exported into the shell), `session_stop` (saves the session as it is and stops billing), `session_resume` (brings a stopped session back as it was), `session_delete` (deletes it and what it saved, for good), `session_move` (to a fresh machine, keeping tabs, logins and files) |
| Browser | `browser_navigate`, `browser_click`, `browser_type` (text, or a saved credential), `browser_login` (sign in with a saved password), `browser_press`, `browser_read` (Markdown or text), `browser_screenshot` |
| Credentials | `credentials_list` (names, types, sites and a password's code source for the saved passwords and secrets, never their values) |
| Mouse and keyboard | `mouse_move`, `mouse_click`, `mouse_drag`, `hover`, `key`, `computer` (screenshot-driven computer use) |
| Shell and code | `run_command` (bash in the session), `run_playwright` (Playwright code next to the browser) |
| Files | `list_files`, `read_file`, `write_file` (the session's workspace) |
| Web | `fetch_url` (a page through a real browser, no session needed), `web_search` (with the top pages as Markdown) |

### Signing in without showing the agent a password

Save a website password (or a secret) as a **credential** in the Boxline console, the [CLI](https://www.npmjs.com/package/@boxline/cli) or an SDK.
The agent calls `credentials_list` to see what exists (names, types and the sites each may be typed on; never a value), then
types it with `browser_type`:

```
browser_type { "credential": "SHOP", "field": "username", "selector": "#email" }
browser_type { "credential": "SHOP", "field": "password", "selector": "#password" }
browser_type { "credential": "SHOP", "field": "otp", "selector": "#code" }   // the current 2FA code, if the password has a 2FA key
```

Or sign in in one call with `browser_login { "credential": "SHOP", "url": "https://shop.example.com/login" }`: a short run in the
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
recording and logs. The default session is resumed by the server when it has stopped.

## Links

- Docs: [docs.boxline.dev](https://docs.boxline.dev)
- Node SDK: [Boxline-dev/sdk-node](https://github.com/Boxline-dev/sdk-node) · Python SDK: [Boxline-dev/sdk-python](https://github.com/Boxline-dev/sdk-python)

MIT licence.

---

This repository holds the Boxline MCP server (@boxline/mcp). It is copied from Boxline's main repository on every change. Issues and pull requests are welcome here; accepted changes are made there and arrive with the next copy.
