---
name: Serving Agency Code
description: How to expose exported Agency functions and nodes over MCP (stdio) or HTTP REST so external tools and services can invoke your agents.
---

# Serving Agency Code

Agency can serve your functions and nodes over MCP or HTTP.

## Exporting Functions and Nodes

Only items marked with `export` are exposed by the serve system:

```ts
export def add(a: number, b: number): number {
  return a + b
}

export node main(message: string) {
  return process(message)
}

```

## MCP Server

Start an MCP server over stdio:

```bash
agency serve mcp myagent.agency
agency serve mcp myagent.agency --name "My Agent"
```

Options:
- `--name <name>` — Server name (defaults to filename)
- `--transport <transport>` — Transport: 'stdio' (default) or 'http' (Streamable HTTP)
- `--port <port>` - HTTP port (http transport only, default: 3545)
- `--host <host>` - Interface to bind to (http transport only, default: 127.0.0.1, loopback only). Use 0.0.0.0 to expose externally (requires --api-key/--api-key-env).
- `--path <path>` - Endpoint path the MCP server is mounted at (http transport only, default: /mcp)
- `--api-key <key>` - API key for authentication (http transport only). NOT recommended: visible in process listings. Prefer --api-key-env.
- `--api-key-env <name>` - Name of the environment variable to read the API key from (http transport only). For --standalone, the bundle reads this env var at runtime (default: API_KEY).
- `--standalone` - Generate a standalone server.js file

## HTTP Server

Start an HTTP REST server:

```bash
agency serve http myagent.agency
agency serve http myagent.agency --port 8080
agency serve http myagent.agency --api-key my-secret-key
```

The `http` command has similar options as the `mcp` command. Run `agency serve http --help` for more information.


### Routes

**`GET /list`** — Returns a manifest of available functions and nodes:

```json
{
  "functions": [
    { "name": "add", "description": "Adds two numbers together.", "safe": true }
  ],
  "nodes": [
    { "name": "main", "parameters": ["message"] }
  ]
}
```

**`POST /function/:name`** — Call an exported function:

```bash
curl -X POST http://localhost:3545/function/add \
  -H 'Content-Type: application/json' \
  -d '{"a": 3, "b": 4}'
```

Response:
```json
{ "success": true, "value": 7 }
```

**`POST /node/:name`** — Run an exported node:

```bash
curl -X POST http://localhost:3545/node/main \
  -H 'Content-Type: application/json' \
  -d '{"message": "hello"}'
```

Response:
```json
{ "success": true, "value": { "result": "processed hello" } }
```

### Interrupts

If a node triggers an interrupt during execution, the response includes the interrupt data:

```json
{
  "success": true,
  "value": {
    "interrupts": [
      { "type": "interrupt", "effect": "std::read", "message": "Do you approve?" }
    ]
  }
}
```

To resume after an interrupt, use **`POST /resume`** with the interrupts and your responses:

```bash
curl -X POST http://localhost:3545/resume \
  -H 'Content-Type: application/json' \
  -d '{
    "interrupts": [... the interrupts array from above ...],
    "responses": [{"type": "approve"}]
  }'
```

The `responses` should correspond positionally to the `interrupts`.

### Authentication

When `--api-key` is set, all requests must include a Bearer token:

```bash
curl -H 'Authorization: Bearer my-secret-key' http://localhost:3545/list
```

Requests without a valid token receive a `401 Unauthorized` response.

### Standalone Mode

Generate a self-contained server file.

```bash
agency serve http myagent.agency --standalone
```

This produces a bundled `.server.js` file. Users can run this file directly with Node, without needing Agency installed.

Also see [`pack`](/cli/pack).