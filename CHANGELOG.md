# Changelog

All notable changes to `@boxline/mcp`.

## 2.0.0 (2026-10-07)

Moves to the MCP TypeScript SDK 2 (`@modelcontextprotocol/server`) and the MCP revision 2026-07-28. Clients that speak the
2025 protocol keep working.

### Breaking

- **No default session: `sessionId` is required.** `session_create` returns the session's id, and every tool that works
  in a session (`browser_*`, `mouse_*`, `hover`, `key`, `computer`, `run_command`, `run_playwright`, `list_files`,
  `read_file`, `write_file`, `session_stop`, `session_resume`, `session_delete`, `session_move`, `browser_login`) takes it
  as a required `sessionId`. The server keeps nothing between calls, as the new MCP revision asks: state travels as a handle
  in the arguments. A tool that acts, given the id of a stopped session, resumes it first, as it was; the read-only tools (`browser_read`,
  `browser_screenshot`, `list_files`, `read_file`) refuse it and say to call `session_resume` (a resume starts billing). `fetch_url`, `web_search`,
  `session_create` and `credentials_list` take none.
- **Node 20 or newer** (`engines.node`).

### Added

- **HTTP mode: `boxline-mcp --http`** serves the tools at `POST /mcp` for clients that connect to a URL. Every request
  carries its own API key as `Authorization: Bearer <API key>` (`401` with `WWW-Authenticate: Bearer` without it), and the
  server is stateless, so any number of copies behind a load balancer can serve any request. It serves 2026-07-28 clients
  and, statelessly, the 2025-era protocol. `GET /healthz` answers `200 ok`. Settings: `MCP_PORT` (8081), `MCP_HOST`
  (0.0.0.0), `MCP_ALLOWED_HOSTS` (host names it answers to; a request with another `Host`, or a browser `Origin` that is not
  one of them, gets `403`), `MCP_TOOLS` and `BOXLINE_API_URL`. Request bodies are limited to 4 MiB and 32 requests run at once (`MCP_MAX_IN_FLIGHT`); live view URLs are left out of tool results. See the README.
- **Tool annotations.** Every tool has a title and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint`, so clients
  can decide what to ask about: `browser_read`, `browser_screenshot`, `list_files`, `read_file`, `credentials_list`,
  `fetch_url` and `web_search` are read-only; `session_delete`, `write_file`, `run_command` and `run_playwright` are
  destructive; tools that reach the web are open-world.
- **`MCP_TOOLS=directory`** (HTTP mode) leaves out `browser_login`, `credentials_list` and every credential parameter
  (`credential` and `field` on `browser_type`, `credentials` on `session_create`), for servers listed in a public connector
  directory. The default, `full`, is unchanged.
- The server's version in the MCP handshake is the package's own version, and the server sends short usage instructions
  (create a session first, pass its id).
- `session_create` also returns whether the session has a shell. When no `shell` is asked for and the plan or the API does
  not allow one, it creates a browser-only session, as the default session used to.

## 1.0.0 (2026-10-05)

Built on the Node SDK 2.0 (`@boxline/sdk` `^2.0.0`).

### Breaking

- **`session_close` is gone: `session_stop`, `session_resume` and `session_delete` replace it.** `session_stop` saves the
  session exactly as it is (every tab, the files) and stops billing; a stopped session is free and is kept for the plan's
  retention days. `session_resume {sessionId}` brings it back as it was. `session_delete {sessionId}` deletes it for
  good, with what it saved, its recording and its logs. The server resumes its default session itself when that one has
  stopped (its time ran out, say); a tool given the id of a stopped session answers `session_not_running`: resume it first.

## 0.3.0 (2026-10-03)

Built on the Node SDK 1.3 (`@boxline/sdk` `^1.3.0`).

### Added

- **`browser_login {credential, url?}`**: signs the session's browser in with a saved password credential in one call.
  A short run in the session types the credential on its own sites only; the model never sees the password, a 2FA code
  or a sign-in link. `url` is the sign-in page (one of the credential's sites). A credential whose code source is
  `push` or `url` waits, up to its timeout, for the code or link the user's system sends. A login that takes too long
  (15 steps, plus that timeout) is stopped and the tool answers `credential_login_timeout`; the page it returns is only
  an origin when it is the page a sign-in link opened.
- **`credentials_list` shows each password's `codeSource`** (`totp`, `push`, `url`, or null for no 2FA); `otp` is among
  its `fields` when it has one. Never a value, the address a `url` source asks, or its signing secret.
- `browser_type` with `field: "otp"` waits for a fresh code when the credential's source is `push` or `url`.

## 0.2.0 (2026-10-03)

Built on the Node SDK 1.2 (`@boxline/sdk` `^1.2.0`).

### Added

- **`credentials_list`**: the project's saved credentials (passwords and secrets) as names, types, the sites each may be
  typed on, where each may be used and, for a password, the fields `browser_type` can type (`username`, `password`, and
  `otp` when it has a 2FA key). It never shows a value.
- **`browser_type` takes `credential` and `field`** instead of `text`: the platform types the credential's value into
  the field `selector` names, only on the sites it was saved for, without the model seeing it. `field` is `username`,
  `password` or `otp` (the current 2FA code) for a password credential, and left out for a secret.
- **`session_create` takes `profile`** (the id of a saved browser profile to start from; `persistProfile` saves its
  logins back when the session ends) **and `credentials`** (names of saved credentials exported into the session's
  shell as environment variables, for those whose scope allows the shell).
- No tool creates, changes or deletes a credential: that would send passwords and keys through the chat. Add them in
  the console, with the CLI or with an SDK.
- What `browser_type` types with a credential is hidden afterwards in `browser_read`, the page's elements, screenshots
  and errors of that session (the text shows `%NAME.password%`, the field is covered). It is a guard against showing a
  value by accident, not a boundary: `run_playwright` and commands in the session can still read a field.
