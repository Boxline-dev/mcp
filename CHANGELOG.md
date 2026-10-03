# Changelog

All notable changes to `@boxline/mcp`.

## 0.2.0 (unreleased)

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
