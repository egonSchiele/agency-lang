# Serving Agency Code

Agency can serve your functions and nodes over MCP (stdio) or HTTP REST, letting external tools and services call into your agents.

## Exporting Functions and Nodes

Only items marked with `export` are exposed by the serve system:

```agency
export safe def add(a: number, b: number): number {
  """
  Adds two numbers together.
  @param a - First number
  @param b - Second number
  """
  return a + b
}

export node main(message: string) {
  // This node will be callable via the serve system
  return process(message)
}

def internal(): string {
  // This function is NOT exported — it won't appear in the serve API
  return "only used internally"
}
```

The `safe` modifier tells the serve system that a function is read-only (no side effects). MCP clients see this as a `readOnlyHint` annotation.

## MCP Server

Start an MCP server over stdio:

```bash
agency serve mcp myagent.agency
agency serve mcp myagent.agency --name "My Agent"
```

Options:
- `--name <name>` — Server name reported to MCP clients (defaults to filename)

The server implements the MCP protocol (JSON-RPC 2.0 over stdio) with `tools/list` and `tools/call`. Each exported function becomes an MCP tool with its description and Zod-derived JSON Schema.

## HTTP Server

Start an HTTP REST server:

```bash
agency serve http myagent.agency
agency serve http myagent.agency --port 8080
agency serve http myagent.agency --api-key my-secret-key
```

Options:
- `--port <port>` — Port to listen on (default: 3000)
- `--api-key <key>` — Require Bearer token authentication
- `--standalone` — Generate a bundled `server.js` file instead of starting a server

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

**`POST /functions/:name`** — Call an exported function:

```bash
curl -X POST http://localhost:3000/functions/add \
  -H 'Content-Type: application/json' \
  -d '{"a": 3, "b": 4}'
```

Response:
```json
{ "success": true, "value": 7 }
```

**`POST /nodes/:name`** — Run an exported node:

```bash
curl -X POST http://localhost:3000/nodes/main \
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
      { "type": "interrupt", "kind": "std::read", "message": "Do you approve?" }
    ],
    "state": "..."
  }
}
```

To resume after an interrupt, use **`POST /resume`** with the interrupts and your responses:

```bash
curl -X POST http://localhost:3000/resume \
  -H 'Content-Type: application/json' \
  -d '{
    "interrupts": [... the interrupts array from above ...],
    "responses": [{"type": "approve"}]
  }'
```

The `responses` array corresponds positionally to the `interrupts` array.

### Authentication

When `--api-key` is set, all requests must include a Bearer token:

```bash
curl -H 'Authorization: Bearer my-secret-key' http://localhost:3000/list
```

Requests without a valid token receive a `401 Unauthorized` response.

### Standalone Mode

Generate a self-contained server file that can be deployed without the Agency CLI:

```bash
agency serve http myagent.agency --standalone
```

This produces a bundled `.server.js` file via esbuild.

## What Gets Exported

| Syntax | Served as |
|---|---|
| `export def foo()` | MCP tool / HTTP function |
| `export safe def foo()` | MCP tool (with readOnlyHint) / HTTP function |
| `export node main()` | HTTP node |
| `export static const x = ...` | Available in module but not directly callable |
| `def foo()` (no export) | Not served |
| `node main()` (no export) | Not served |
