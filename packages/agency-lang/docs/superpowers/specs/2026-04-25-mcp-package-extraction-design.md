# MCP Package Extraction Design

## Goal

Move all MCP functionality out of the main `agency-lang` package into a separate `@agency-lang/mcp` package at `packages/mcp/`. This removes the `@modelcontextprotocol/sdk` dependency (and its transitive dependencies) from the main package, keeping it lean. Users who need MCP install the separate package.

## User-Facing API

Users import `mcp()` from the package instead of using it as a builtin:

```
import { mcp } from "pkg::@agency-lang/mcp"

node main() {
  let tools = mcp("filesystem")
  let result: string = llm("List files in the current directory", tools: tools)
  print(result)
}
```

The only change from the current API is adding the import line. Everything else — passing tools to `llm()`, filtering, combining tools from multiple servers — works identically.

For TypeScript interop:

```typescript
import { mcp, McpTool, McpServerConfig } from "@agency-lang/mcp"
```

### `mcp()` Signature

```
mcp(serverName: string, onOAuthRequired?: (data: OAuthData) => void)
```

The optional `onOAuthRequired` callback allows custom OAuth handling for HTTP servers that require it. If omitted, the default behavior is to open the browser automatically.

## Package Structure

```
packages/mcp/
  package.json          # @agency-lang/mcp
  index.agency          # exports mcp() function
  src/
    mcpManager.ts       # from lib/runtime/mcp/mcpManager.ts
    mcpConnection.ts    # from lib/runtime/mcp/mcpConnection.ts
    oauthConnector.ts   # from lib/runtime/mcp/oauthConnector.ts
    oauthProvider.ts    # from lib/runtime/mcp/oauthProvider.ts
    callbackServer.ts   # from lib/runtime/mcp/callbackServer.ts
    tokenStore.ts       # from lib/runtime/mcp/tokenStore.ts
    toolAdapter.ts      # from lib/runtime/mcp/toolAdapter.ts
    types.ts            # from lib/runtime/mcp/types.ts
    config.ts           # reads agency.json, validates mcpServers section
    auth.ts             # from lib/cli/auth.ts (agency auth CLI command)
  tests/                # moved MCP unit tests
```

### package.json

- `@modelcontextprotocol/sdk` as a regular dependency
- `agency-lang` as a peer dependency (needed for runtime types like `AgencyFunction`, `Result`)
- `"agency": "./index.agency"` entrypoint
- Compiled `.js` and `.agency` files in `"files"`

## Key Design Decisions

### mcp() Returns AgencyFunction[] Directly

The `mcp()` function inside the package calls `McpManager.getTools()`, then converts all raw MCP tools to `AgencyFunction` instances before returning. This means:

- No changes needed to `prompt.ts`'s core tool processing logic
- No adapter registry or plugin mechanism on `RuntimeContext`
- The MCP tool detection code (`isMcpTool`) and conversion code (`mcpToolToAgencyFunction`) move entirely into the package
- `prompt.ts` only needs to handle `AgencyFunction` instances — the MCP-specific detection path is removed

### Package Reads agency.json Directly

The MCP package reads `agency.json` at runtime to get the `mcpServers` configuration. This means:

- The main compiler does not need to know about MCP config at all
- No config sanitization needed (the package reads the full config including secrets at runtime, rather than the compiler embedding a sanitized version in generated code)
- MCP config validation schemas move from `lib/config.ts` to the package
- The package finds `agency.json` by looking in the working directory (walking up parent dirs)

### Singleton McpManager

The package maintains a module-level singleton `McpManager`:

- Created on first `mcp()` call, reused for all subsequent calls
- Connection pooling and tool caching work the same as today
- Concurrent agent calls safely share the singleton (McpManager already handles concurrent connection deduplication)
- Cleanup via `process.on('beforeExit')` calling `mcpManager.disconnectAll()`

### OAuth Callbacks

The `onOAuthRequired` callback is passed as an optional second argument to `mcp()`. The callback provided on the first call for a given server is used for that server's connection lifecycle.

## Removals from Main Package

### Removed entirely

- `lib/runtime/mcp/` — all files (mcpManager, mcpConnection, oauth*, tokenStore, toolAdapter, types)
- `lib/cli/auth.ts`
- `lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.mustache` and generated `.ts`
- MCP config validation schemas from `lib/config.ts` (`McpStdioServerSchema`, `McpHttpServerSchema`, etc.)
- `@modelcontextprotocol/sdk` dependency from package.json

### Modified

- `lib/runtime/state/context.ts` — remove `McpManager` field, `createMcpManager()`, `disconnectMcp()`, the import
- `lib/runtime/prompt.ts` — remove `isMcpTool` detection and `mcpToolToAgencyFunction` conversion; tools array expects `AgencyFunction` instances only
- `lib/backends/typescriptBuilder.ts` — remove MCP config sanitization in `buildRuntimeContext()`, remove `"mcp"` from `DIRECT_CALL_FUNCTIONS`
- `lib/backends/typescriptGenerator/builtins.ts` — remove mcp builtin generation
- `lib/runtime/index.ts` — remove MCP exports
- `scripts/agency.ts` — remove `agency auth` commands

### Kept as-is

- `lib/mcp/server.ts` and `lib/mcp/setup.ts` — the LSP MCP server for coding agents is unrelated to the user-facing `mcp()` function and stays in the main package

## Concurrency and Interrupts

- **Interrupts**: MCP tools are returned as `AgencyFunction` instances. When an interrupt fires, the execution state is serialized but the functions themselves are not — they are recreated on resume when `mcp()` is called again. The singleton McpManager stays alive across interrupts.
- **Concurrent agent calls**: `McpManager` is already designed for concurrency — `getTools()` deduplicates concurrent connection attempts per server, connections are pooled, and `callTool()` is stateless per invocation. Multiple concurrent agent calls sharing the singleton is identical to the current behavior where the manager is shared via `RuntimeContext`.

## Migration

Users upgrading will need to:

1. Install the MCP package: `npm install @agency-lang/mcp`
2. Add `import { mcp } from "pkg::@agency-lang/mcp"` to any `.agency` file that uses `mcp()`

3. Use `npx @agency-lang/mcp auth <server>` instead of `agency auth <server>` for OAuth token management

### Bare `mcp()` Calls Without Import

Since `mcp()` is no longer a builtin, calling it without importing from the package is the same as calling any undefined function — the compiler (or typechecker) will report an undefined function error. No special handling is needed.

### OAuth Callback API Change

The `onOAuthRequired` callback changes from a lifecycle callback registered on `RuntimeContext` (via `_registeredCallbacks`) to a per-call argument on `mcp()`. This is a deliberate simplification — the callback is scoped to the server it's relevant to rather than being a global setting.

### CLI: `agency auth` Replacement

The MCP package provides a `bin` entry in its `package.json` so that `npx @agency-lang/mcp auth <server>` works. This supports `auth <server>` (initiate OAuth flow), `auth --list` (list stored tokens), and `auth --revoke <server>` (delete token). The `agency auth` command is removed from the main CLI entirely.
