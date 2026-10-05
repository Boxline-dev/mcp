# Changelog

All notable changes to `@boxline/mcp`.

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
