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
| Sessions | `session_create`, `session_close` (stops billing), `session_move` (to a fresh machine, keeping tabs, logins and files) |
| Browser | `browser_navigate`, `browser_click`, `browser_type`, `browser_press`, `browser_read` (Markdown or text), `browser_screenshot` |
| Mouse and keyboard | `mouse_move`, `mouse_click`, `mouse_drag`, `hover`, `key`, `computer` (screenshot-driven computer use) |
| Shell and code | `run_command` (bash in the session), `run_playwright` (Playwright code next to the browser) |
| Files | `list_files`, `read_file`, `write_file` (the session's workspace) |
| Web | `fetch_url` (a page through a real browser, no session needed), `web_search` (with the top pages as Markdown) |

Sessions are billed while they run: close them with `session_close` when the work is done, or let them end at their
time limit.

## Links

- Docs: [docs.boxline.dev](https://docs.boxline.dev)
- Node SDK: [Boxline-dev/sdk-node](https://github.com/Boxline-dev/sdk-node) · Python SDK: [Boxline-dev/sdk-python](https://github.com/Boxline-dev/sdk-python)

MIT licence.

---

This repository holds the Boxline MCP server (@boxline/mcp). It is copied from Boxline's main repository on every change. Issues and pull requests are welcome here; accepted changes are made there and arrive with the next copy.
