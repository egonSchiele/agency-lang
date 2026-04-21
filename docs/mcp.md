# Agency MCP Server

The Agency MCP server exposes Agency code intelligence to MCP-capable coding agents such as Codex.

## Start the server

```bash
agency mcp
```

The server uses MCP stdio transport.

## Codex setup

Generate or update your Codex MCP config:

```bash
agency mcp setup codex
```

By default this writes to `~/.codex/config.toml`.
It writes a stable `agency mcp` command, so the generated config does not depend on the path of the checkout or the installer that created it.

You can override the destination:

```bash
agency mcp setup codex --codex-config /path/to/config.toml
```

## Exposed tools

- `agency_diagnostics`
- `agency_definition`
- `agency_hover`
- `agency_document_symbols`
- `agency_format`
- `agency_completions`

Each tool accepts a `file_path`, and most also accept optional in-memory `text` so the client can analyze unsaved edits.
