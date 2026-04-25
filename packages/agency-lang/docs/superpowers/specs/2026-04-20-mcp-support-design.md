# MCP Support Design

## Overview

This spec adds Model Context Protocol (MCP) support to Agency, allowing users to connect to MCP servers and use their tools alongside regular Agency tools in LLM calls. MCP servers expose tools over a standardized protocol — Agency acts as an MCP client, fetching tool definitions and routing tool calls to the appropriate server.

## Motivation

Agency users can define functions and pass them as tools to LLM calls. But many useful tools already exist as MCP servers — filesystem access, databases, APIs, etc. Without MCP support, users must reimplement these as Agency functions or write TypeScript glue code.

MCP is becoming the standard protocol for tool interop across AI applications. Supporting it lets Agency users tap into the growing MCP ecosystem with minimal code.

### Design goals

- **Explicit control.** Users choose which MCP servers to connect to and which tools to expose to each LLM call. No auto-injection.
- **Familiar patterns.** MCP tools are passed via the same `tools` array as regular tools. The user filters, combines, and spreads them using standard Agency operations.
- **Minimal compiler changes.** Almost all logic lives in the runtime, where it's testable and type-safe.
- **Graceful failure.** `mcp()` returns a `Result` type so users can handle connection failures without crashing the agent.

## Design

### User-facing API

The `mcp()` built-in function connects to a named MCP server (defined in `agency.json`) and returns a `Result` containing an array of tool objects:

```ts
const tools = mcp("filesystem") catch []
const result = llm("List my files", { tools: [foo, bar, ...tools] })
```

The returned tools are plain objects that can be filtered, assigned to variables, and spread into arrays:

```ts
const allTools = mcp("filesystem") catch []
const safeTools = filter(allTools) as tool {
  return tool.name != "filesystem__delete_file"
}
const result = llm("Summarize my files", { tools: [foo, ...safeTools] })
```

Each tool object has a `name` (prefixed with the server name), `description`, `serverName`, and `inputSchema`:

```ts
{
  name: "filesystem__read_file",
  description: "Read a file from the filesystem",
  serverName: "filesystem",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  __mcpTool: true
}
```

The `__mcpTool: true` marker is an internal field the runtime uses to identify MCP tools in the `tools` array. Users don't need to know about it.

### Tool name prefixing

MCP tool names are prefixed with the server name and a double underscore: `serverName__toolName`. This prevents collisions between:
- MCP tools and Agency-defined tools
- Tools from different MCP servers

If two MCP servers happen to produce the same prefixed name (which would require the same server name — not possible since server names are unique keys in the config), the runtime throws an error at `mcp()` time.

### Configuration

MCP servers are defined in `agency.json` under an `mcpServers` key, using the same format as Claude Code:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    },
    "weather": {
      "type": "http",
      "url": "https://weather-mcp.example.com/mcp"
    }
  }
}
```

**stdio servers:** `command` (required), `args` (optional string array), `env` (optional object of environment variables).

**HTTP servers:** `type: "http"` (required), `url` (required).

The runtime detects the transport based on the presence of `command` (stdio) vs `type` + `url` (HTTP). An entry with neither or both is a config validation error.

Config validation uses a Zod schema defined in `lib/config.ts` alongside the existing `AgencyConfig` type. This schema validates the entire config file, not just the MCP section.

Custom auth headers for HTTP servers are out of scope for now.

### Runtime architecture

**`McpConnection`** (`lib/runtime/mcp/mcpConnection.ts`) — Wraps a single MCP server connection. Responsible for:
- Connecting via the appropriate transport (stdio or HTTP) using `@modelcontextprotocol/sdk`
- Fetching tool definitions via `client.listTools()`
- Calling tools via `client.callTool()`
- Disconnecting and cleaning up

**`McpManager`** (`lib/runtime/mcp/mcpManager.ts`) — Connection pool that lives on `RuntimeContext`. It is placed on the shared/base context (not the per-execution context created by `createExecutionContext()`), so all parallel executions share the same MCP connections. Responsible for:
- Reading `mcpServers` config from `agency.json`
- Creating and caching `McpConnection` instances (one per server name, shared across all calls)
- Providing the `getTools(serverName)` method that `mcp()` calls
- Tearing down all connections when the agent finishes or is cancelled via `disconnectAll()`

**`mcp()` built-in** — Calls `McpManager.getTools(serverName)`, which:
1. Validates the server name exists in config (throws on invalid config)
2. Creates or reuses an `McpConnection` for that server
3. Connects eagerly and calls `listTools()`
4. Wraps each tool into the MCP tool object shape (with prefixed name and `__mcpTool` marker)
5. Returns a `Result` — `success(tools)` on success, `failure(error)` on connection/listing failure

**Tool object lifecycle** — The `mcp()` function returns plain objects to the user (with `name`, `description`, `serverName`, `inputSchema`, `__mcpTool`). These are what the user filters, spreads, and assigns. When these objects reach `prompt.ts` via the `tools` array on an `llm()` call, a helper in `lib/runtime/mcp/` detects entries with `__mcpTool: true` and transforms them into the `{ definition, handler }` pairs that `prompt.ts` expects. The handler is constructed at that point by looking up the `McpConnection` for the tool's `serverName` and calling `client.callTool()`. This keeps the transformation logic in `lib/runtime/mcp/`, not in `prompt.ts`.

**Cleanup** — `McpManager.disconnectAll()` is called in the node/function teardown path before `RuntimeContext.cleanup()`. For stdio servers, this kills the subprocess. For HTTP servers, it closes the session. `disconnectAll()` is also called in the cancellation path (`AgencyCancelledError`).

### Compiler changes

Minimal:
- Add `mcp` to `BUILTIN_FUNCTIONS` in `lib/config.ts` so `isBuiltinFunction("mcp")` returns true.
- Add a Mustache template in `lib/templates/backends/typescriptGenerator/builtinFunctions/` that generates a local wrapper function: `async function mcp(serverName: string) { return __ctx.mcpManager.getTools(serverName); }`. This follows the same pattern as other built-ins like `input`, `read`, etc.
- No new AST node type. No parser changes. `mcp("filesystem")` is syntactically a regular function call.
- The `tools` array in the `llm()` config can contain a mix of registry lookups (Agency tools) and MCP tool objects. A small helper in `lib/runtime/mcp/` handles the conversion, keeping `prompt.ts` changes minimal.

### Serialization and restore

MCP tool objects serialize as plain JSON:

```json
{
  "__mcpTool": true,
  "serverName": "filesystem",
  "name": "filesystem__read_file",
  "description": "Read a file from the filesystem",
  "inputSchema": { ... }
}
```

On restore:
1. Tool objects deserialize as plain data (no special handling needed)
2. When they appear in a `tools` array on an `llm()` call, the runtime sees `__mcpTool: true` and asks `McpManager` for a connection
3. `McpManager` reconnects lazily (only when the tool is actually used after restore, not at restore time)
4. The tool call proceeds normally

### Error handling

**`mcp()` call errors (return `Result` failures):**
- Connection failure (server not running, bad URL, subprocess fails to start)
- `tools/list` fails or times out

**`mcp()` call errors (thrown):**
- Server name not found in `agency.json` — programmer mistake, throws immediately
- Invalid config (neither `command` nor `url`, or both) — caught by Zod schema validation, throws at config load time

**Tool call errors:**
- MCP server returns an error for `tools/call` — reported back to the LLM as a tool error message (same as how Agency handles regular tool errors), letting the LLM retry or adapt
- Connection drops mid-conversation — handler throws, caught by existing error handling in `executeToolCalls`, reported as tool error

### Interrupts and handlers

MCP tools are external and cannot throw Agency interrupts. They execute directly without interrupt gating. If users want safety checks, they can:
- Filter out dangerous tools before passing them to `llm()`
- Wrap the `llm()` call in a `handle` block

A dedicated interrupt gate for MCP tools could be added later as a separate feature.

### Config validation

Currently, `AgencyConfig` is a plain TypeScript interface with no runtime validation. As part of this work, a Zod schema for the full `AgencyConfig` is created from scratch in `lib/config.ts` alongside the existing TypeScript type. This validates the entire config file, including the new `mcpServers` section. The schema is used when the config is loaded at runtime.

The MCP server config schema:

```ts
const McpStdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const McpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
});

const McpServerSchema = z.union([McpStdioServerSchema, McpHttpServerSchema]);
```

## Testing

### Test infrastructure

A test MCP server in `tests/mcp/helpers/testServer.ts` using `@modelcontextprotocol/sdk/server`. The server exposes a simple `add` tool (no filesystem or side effects):

```ts
server.tool("add", { a: { type: "number" }, b: { type: "number" } }, async ({ a, b }) => {
  return { content: [{ type: "text", text: String(a + b) }] };
});
```

Shared test utilities in `tests/mcp/helpers/mcpTestUtils.ts` for starting/stopping test servers and creating test configs.

### Unit tests (`tests/mcp/`)

- `mcpConnection.test.ts` — connect/disconnect, listTools, callTool, error cases return failures
- `mcpManager.test.ts` — connection caching (same server name reuses connection), disconnectAll, config validation throws on invalid config

### Integration tests (`tests/mcp/`)

- `mcp.test.ts` — spin up a real test MCP server via stdio, connect to it, list tools, verify tool object shape (prefixed names, `__mcpTool` marker), call tools, test serialization round-trip (checkpoint with MCP tools in state, restore, verify tools work after restore)

## Dependencies

**New:**
- `@modelcontextprotocol/sdk` — added to `dependencies` in `package.json` (used at runtime for client, in tests for server)

## New files

- `lib/runtime/mcp/mcpConnection.ts` — single server connection wrapper
- `lib/runtime/mcp/mcpManager.ts` — connection pool, lives on RuntimeContext
- `lib/runtime/mcp/types.ts` — McpTool type, config types
- `tests/mcp/helpers/testServer.ts` — test MCP server script (stdio)
- `tests/mcp/helpers/mcpTestUtils.ts` — shared test utilities
- `tests/mcp/mcpConnection.test.ts`
- `tests/mcp/mcpManager.test.ts`
- `tests/mcp/mcp.test.ts`

## Modified files

- `lib/config.ts` — add `mcpServers` to `AgencyConfig` type, add Zod schema for full config validation
- `lib/runtime/state/context.ts` — add `McpManager` property to `RuntimeContext` and assign it in `createExecutionContext()` so parallel executions share the same instance
- `lib/runtime/prompt.ts` — small change to delegate `__mcpTool` entries to helper in `lib/runtime/mcp/`
- `lib/backends/typescriptBuilder.ts` — register `mcp` as a built-in function

## Out of scope

- Custom auth headers for HTTP servers
- Calling MCP tools directly from Agency code (without an LLM call)
- Inline MCP config in `mcp()` calls (option B)
- OAuth 2.0 flow
- SSE transport (only stdio and Streamable HTTP)
- Connection timeout configuration (uses SDK defaults)
- Lifecycle hooks for MCP events (`onMcpConnect`, `onMcpToolCall`, etc.)
