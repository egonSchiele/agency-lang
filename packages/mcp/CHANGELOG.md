# Changelog

## Nov 16 2026 — v0.0.6

### Added
- **Connect without a login.** `connectServer(name, { config })` connects one server and never starts a login. A server that needs one comes back as `{ status: "needsLogin" }` instead of opening a browser and waiting.
- **Log in in two steps.** `startLogin(name, { config })` starts a login and returns the login page URL without waiting. `finishLogin(name)` waits for the browser, saves the login, and connects. `cancelLogin(name)` stops a login in progress. A program can open the page however it likes between the two steps.
- **Server state.** `serverStates()` returns every server's state (`connected` with its tools, `needsLogin`, or `failed` with a message) without connecting anything. `logout(name)` deletes the saved login and keeps the client registration. `disconnectServer(name)` closes a connection.
- **Connect later.** `configureServers({ config })` stores the config without connecting. `pendingServers()` lists the stored servers that have no state yet. `markServerFailed(name, message)` records a server as failed without connecting, for example when starting it was not approved.
- **Local overrides.** Servers in `agency.local.json` replace servers with the same name in `agency.json`.

None of the new functions throws. Each returns a `failed` state with the reason instead.

### Changed
- Once one of the new functions has touched a server, nothing starts a login for it on its own. A tool call on such a server with no connection fails with `MCP server "<name>" needs a new login.` or `MCP server "<name>" is not connected. Reconnect it first.` instead of reconnecting. Servers that only `mcp()` and `mcpRaw()` touched behave as before.
- A config passed to `mcpRaw` on an existing manager now replaces the stored one, instead of being ignored with a warning. `connectServer` and `startLogin` change only their own server's entry.
- Only one login can be in progress per process, because every login's callback page uses port 19876. A new login cancels the one in progress. When another process holds the port, the login fails with `another login is in progress (port 19876 is in use). Finish or cancel it, then try again.`
- The callback page closes itself 30 minutes after it starts, so a login that is started and never finished does not hold the port.
- The package now needs `agency-lang` 0.21.0 or newer.

### Fixed
- Cancelling a login no longer hangs. The wait ends with `login cancelled`.
- A login that expired during a session no longer breaks every later call to the server. The SDK refreshes it with the saved refresh token.
- A refresh token the server rejects is now deleted, so the SDK stops retrying with it. The saved login is deleted only when it still holds the token the server rejected.
- Several tool calls that find the access token expired at the same moment no longer fail with `invalid_grant`. Refresh requests go one at a time, each with the newest refresh token, which matters for servers that issue a new refresh token on every refresh.
- The callback page no longer keeps the browser's connection open after it stops, which could keep the process alive.

## Jul 11 2026 — v0.0.3

### Added
- **`validateMcpServers(servers)`** — validate an `mcpServers` map against the
  same schema `readMcpConfig` uses, without throwing. Returns a `success()`
  Result when valid, or a `failure()` whose error describes the problem. Used by
  the agent's `mcp add` to reject a bad server before it is written.

## Jul 11 2026 — v0.0.2

### Added
- **`mcpRaw(serverName, { config?, onOAuthRequired? })`** — a programmatic entry point for consumers (e.g. the agency agent) that need to inject a server-config object instead of reading it from `agency.json`, and that want the raw tool list plus a `callTool` function so they can wrap the call (for policy gating). Returns `{ tools, callTool }` on success.
- Re-exports `readMcpConfig` and `mcpToolToAgencyFunction` for the same consumers.
- **`MCP_PACKAGE_VERSION`** — the package version, resolvable from both source and the built `dist`.

### Changed
- Config injection and `onOAuthRequired` are documented as first-caller-wins (the manager is a process-wide singleton). A `config` passed to `mcpRaw` after the singleton already exists is now warned about rather than silently dropped.

## Initial release — v0.0.1

- MCP (Model Context Protocol) client for the Agency language: connect to stdio and HTTP MCP servers, OAuth with token storage under `~/.agency/tokens/`, and `mcp("serverName")` returning the server's tools as Agency functions.
