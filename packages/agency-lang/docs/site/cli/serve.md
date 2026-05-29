---
title: Serving Agency code
description: Documents the `agency serve mcp` and `agency serve http` commands for exposing exported functions and nodes as an MCP server or a JSON HTTP REST API, including auth and standalone bundling options.
---

# Serving Agency code

You can expose the functions and nodes in an Agency file as either an MCP server or an HTTP REST API using `agency serve`. Only `export`-ed items are served.

## Serving over MCP

```
agency serve mcp file.agency
```

This starts an MCP server over stdio that exposes every exported function in `file.agency` as an MCP tool. Functions marked `safe` are advertised with the `readOnlyHint` annotation so MCP clients know they're read-only.

### Options

- `--name <name>` — server name (defaults to the filename).
- `--transport <transport>` — `stdio` (default) or `http` for Streamable HTTP.
- `--port <port>` — HTTP port. `http` transport only. Defaults to `3545`.
- `--host <host>` — interface to bind to. `http` transport only. Defaults to `127.0.0.1` (loopback only). Use `0.0.0.0` to expose the server externally — this requires `--api-key` or `--api-key-env`.
- `--path <path>` — endpoint path the MCP server is mounted at. `http` transport only. Defaults to `/mcp`.
- `--api-key <key>` — API key for authentication. `http` transport only. **Not recommended** — the key is visible in process listings. Prefer `--api-key-env`.
- `--api-key-env <name>` — name of the environment variable to read the API key from. `http` transport only. Defaults to `API_KEY`. When using `--standalone`, the bundle reads this env var at runtime.
- `--standalone` — generate a standalone `server.js` file that bundles everything needed to run the server, so you can deploy it without needing the Agency CLI installed.

## Serving over HTTP

```
agency serve http file.agency
```

This starts a JSON HTTP REST server that exposes:

- `GET /list` — manifest of the file's functions and nodes.
- `POST /functions/:name` — invoke a function.
- `POST /nodes/:name` — invoke a node.
- `POST /resume` — resume a paused run by sending back `{ interrupts, responses }`.

### Options

- `--port <port>` — HTTP port. Defaults to `3545`.
- `--host <host>` — interface to bind to. Defaults to `127.0.0.1` (loopback only). Use `0.0.0.0` to expose externally — this requires `--api-key` or `--api-key-env`.
- `--api-key <key>` — API key for authentication. **Not recommended** — visible in process listings. Prefer `--api-key-env`.
- `--api-key-env <name>` — name of the environment variable to read the API key from. Defaults to `API_KEY`. Without `--standalone`, the key is read from the env var at serve time. With `--standalone`, the generated bundle reads it at runtime.
- `--standalone` — generate a standalone `server.js` file.

### See also

- You can easily pack up your agent as a standalone cli script with [pack](./pack).