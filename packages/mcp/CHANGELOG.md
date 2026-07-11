# Changelog

## Jul 11 2026 — v0.0.3

### Added
- **`validateMcpServers(servers)`** — validate an `mcpServers` map against the
  same schema `readMcpConfig` uses, without throwing. Returns `{ ok }` or
  `{ ok: false, error }`. Used by the agent's `mcp add` to reject a bad server
  before it is written.

## Jul 11 2026 — v0.0.2

### Added
- **`mcpRaw(serverName, { config?, onOAuthRequired? })`** — a programmatic entry point for consumers (e.g. the agency agent) that need to inject a server-config object instead of reading it from `agency.json`, and that want the raw tool list plus a `callTool` function so they can wrap the call (for policy gating). Returns `{ tools, callTool }` on success.
- Re-exports `readMcpConfig` and `mcpToolToAgencyFunction` for the same consumers.
- **`MCP_PACKAGE_VERSION`** — the package version, resolvable from both source and the built `dist`.

### Changed
- Config injection and `onOAuthRequired` are documented as first-caller-wins (the manager is a process-wide singleton). A `config` passed to `mcpRaw` after the singleton already exists is now warned about rather than silently dropped.

## Initial release — v0.0.1

- MCP (Model Context Protocol) client for the Agency language: connect to stdio and HTTP MCP servers, OAuth with token storage under `~/.agency/tokens/`, and `mcp("serverName")` returning the server's tools as Agency functions.
