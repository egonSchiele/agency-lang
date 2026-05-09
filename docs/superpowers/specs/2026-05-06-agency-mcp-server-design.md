# Agency as an MCP Server Platform

## Overview

Agency programs can currently *consume* MCP servers (connect to external tool servers and use their tools). This spec proposes the reverse: letting users *create* MCP servers from Agency code. Users write Agency functions, mark which ones to export, and run a single command to start an MCP server that exposes those functions as MCP tools.

Agency has unique advantages here that no other MCP server framework offers:
- **Interrupts + policies** for pre-authorized safety gates on destructive actions
- **Partial application** for constraining tool parameters (e.g., lock a directory so the LLM can only choose a filename)
- **State isolation** so concurrent tool calls don't interfere
- **Structured interrupt kinds** that map naturally to policy rules

## Goals

1. Let users expose Agency functions as MCP tools with a single CLI command
2. Use policies to pre-authorize which operations the MCP server is allowed to perform, with safe defaults (reject anything not explicitly approved)
3. Include a built-in `manage_policy` tool so LLM clients can help users set up permissions interactively
4. Support stdio transport initially, with HTTP as a future addition
5. Support exporting both regular functions and partially applied functions (PFAs)

## Non-goals

- MCP Resources, Prompts, Sampling, or Completions (future work if demand warrants)
- HTTP transport and server-side OAuth (future work)
- Changes to the interrupt or policy systems themselves

## Design

### 1. Selective Export

Users control which functions become MCP tools using the existing `export` keyword. Only exported functions and exported PFA constants are exposed to the MCP server.

```typescript
// Internal helper — NOT exposed as an MCP tool
def readFile(dir: string, filename: string): string {
  // The first return is an interrupt: execution pauses here for approval.
  // If approved, execution continues to the second return.
  // This is standard Agency idiom for gating side effects.
  return interrupt std::read("Read file?", { path: "${dir}/${filename}" })
  return try _readFile(dir, filename)
}

// Exposed as MCP tool — PFA constrains the dir parameter
export const readWorkspaceFile = readFile.partial(dir: "/workspace")

// Exposed as MCP tool — plain exported function
export def listFiles(dir: string): string[] {
  return interrupt std::read("List directory?", { path: dir })
  return try _listFiles(dir)
}

// Exposed as MCP tool — no interrupt, runs freely
export safe def add(a: number, b: number): number {
  return a + b
}
```

The MCP server discovers exported tools by walking the tool registry after compiling and loading the Agency file. It filters for AgencyFunction instances that were explicitly exported.

For PFAs, the tool schema automatically reflects only the unbound parameters. `readWorkspaceFile` above would appear to the MCP client as a tool with a single `filename` parameter — `dir` is hidden entirely.

#### Prerequisites: `export const` and export tracking

`export const` for PFA declarations may not be supported in the parser today. If not, this is a prerequisite language change: the parser and compiler need to support `export const` at module scope, and the compiled output needs to register the resulting AgencyFunction as exported.

More broadly, the tool registry currently registers ALL functions, not just exported ones. The compiler needs to propagate an `exported` flag onto AgencyFunction instances so the MCP server can filter the registry. This requires changes to `AgencyFunction` (add an `exported: boolean` field) and to the builder (set the flag during compilation).

### 2. CLI Command

```bash
agency serve <file.agency> [options]
```

Options:
- `--name <name>` — Server name (used for policy storage, MCP server identification). Defaults to the filename without extension.
- `--policy <path>` — Path to a policy JSON file. If omitted, loads from the default location (see section 4).
- `--node <name>` — If the file has initialization logic in a specific node, run it before starting the server.
- `--transport stdio` — Transport type. Only `stdio` initially.

Example:
```bash
agency serve tools.agency --name my-tools
```

This:
1. Compiles `tools.agency`. If compilation fails, prints the error to stderr and exits with a non-zero code.
2. Discovers all exported AgencyFunctions (including PFAs)
3. Loads the policy from `~/.agency/mcp/servers/my-tools/policy.json` (or the path given by `--policy`)
4. Starts a stdio MCP server exposing those functions as tools, plus the built-in `manage_policy` tool

### 3. Interrupt Handling via Policies

In an MCP server context, there is no reliable way to ask the user for permission mid-tool-call. MCP's elicitation feature could support this in the future, but it is new and not widely supported by clients. Returning interrupt data as a tool result relies on the LLM choosing to surface it to the user, which is not guaranteed.

Instead, the MCP server uses **policies as pre-authorization**. Every tool invocation is wrapped in a handler that runs `checkPolicy()`:

```typescript
// Pseudocode for what the MCP server does internally
handle {
  toolFunction(args)
} with (interrupt) {
  const decision = checkPolicy(serverPolicy, interrupt)
  if (decision.type === "propagate") {
    // In MCP mode, propagate means reject (no user to ask)
    return reject()
  }
  return decision
}
```

The key behavioral difference from interactive Agency: **propagate becomes reject**. In interactive mode, propagate means "ask the user." In MCP server mode, there is no user to ask, so unresolved interrupts are rejected. This preserves the safety guarantee: if you didn't explicitly approve it in the policy, it doesn't happen.

Functions without interrupts (like `add` above) execute freely, since they have no side effects worth gating.

### 4. Policy Storage

Policies are stored at `~/.agency/mcp/servers/{server-name}/policy.json`, following the existing `~/.agency/` convention used by OAuth token storage.

Resolution order:
1. `--policy` CLI flag (explicit path)
2. `~/.agency/mcp/servers/{server-name}/policy.json` (user-level, persisted by `manage_policy`)
3. Default policy shipped with the Agency file (a `policy.json` in the same directory, or declared in `agency.json`)
4. Empty policy (all interrupts rejected)

When both a default policy and a user-level policy exist, the user-level policy takes precedence on a per-kind basis. If the user policy has rules for `std::read`, those replace the default rules for `std::read` entirely — there is no partial merging within a kind. Kinds not mentioned in the user policy fall through to the default.

Policy structure (unchanged from existing policy system):
```json
{
  "std::read": [
    { "match": { "path": "src/**" }, "action": "approve" },
    { "match": { "path": "docs/**" }, "action": "approve" },
    { "action": "reject" }
  ],
  "std::write": [
    { "match": { "path": "logs/**" }, "action": "approve" },
    { "action": "reject" }
  ],
  "std::delete": [
    { "action": "reject" }
  ]
}
```

### 5. Built-in `manage_policy` Tool

Every Agency MCP server automatically includes a `manage_policy` tool. This tool helps users configure permissions interactively through the LLM client.

The tool is deliberately declarative — the LLM builds the desired policy and submits it whole, rather than mutating it imperatively with add/remove operations. This avoids ordering bugs (policies are first-match-wins), forgotten saves, and index-based fragility.

The tool supports three operations:

**`list_tools`** — Returns all available tools on this server, with their descriptions and current policy status. Policy status shows which interrupt kinds have rules configured for them, helping the user see which tools are uncovered. We do not attempt to statically determine whether a function can trigger interrupts, since functions may call other functions that throw interrupts, making static analysis unreliable.

**`show_policy`** — Returns the current policy JSON.

**`set_policy`** — Replaces the current policy with the provided policy object and persists it to `~/.agency/mcp/servers/{server-name}/policy.json`. The LLM constructs the full policy and submits it in one call:

```json
{
  "operation": "set_policy",
  "policy": {
    "std::read": [
      { "match": { "path": "src/**" }, "action": "approve" },
      { "action": "reject" }
    ]
  }
}
```

To reset to the default policy (or empty if none), call `set_policy` with an empty object.

The intended UX flow:
1. User connects their MCP client (Claude Desktop, Cursor, etc.) to the Agency MCP server
2. The LLM tries to use a tool, gets a rejection because there's no policy
3. The LLM discovers `manage_policy`, calls `list_tools` to see what's available and `show_policy` to see the current state
4. The LLM walks the user through which tools they want to approve, builds a complete policy, and calls `set_policy` to persist it
5. Subsequent sessions use the saved policy automatically

The `manage_policy` tool itself has no interrupts — it always executes. It can only modify the policy for the current server.

### 6. Tool Definition Mapping

Agency's `AgencyFunction` maps to MCP tool definitions as follows:

| AgencyFunction field | MCP tool field | Notes |
|---|---|---|
| `name` | `name` | Direct mapping |
| `toolDefinition.description` | `description` | Includes docstring, minus `@param` lines for bound params |
| `toolDefinition.schema` (Zod) | `inputSchema` (JSON Schema) | Convert via Zod's built-in JSON Schema support |
| `safe` | `annotations.readOnlyHint` | `true` if function is marked `safe` |

We do not set `annotations.destructiveHint` because reliably determining whether a function can trigger interrupts requires full call-graph analysis (a function may call other functions that throw interrupts). An inaccurate hint is worse than no hint.

#### Prerequisites: AgencyFunction metadata

`AgencyFunction` currently does not store `safe` metadata at runtime. This needs to be added:
- `safe: boolean` — whether the function is marked with the `safe` keyword. Currently tracked in the compilation unit (`safeFunctions`) but not propagated to runtime.

This field should be added to `AgencyFunctionOpts` and set during `AgencyFunction.create()` in the builder output.

### 7. Invocation Adapter

MCP sends tool arguments as `Record<string, unknown>`. AgencyFunction expects a `CallType` descriptor. The adapter:

1. Receives `{ name: string, arguments: Record<string, unknown> }` from MCP `tools/call`
2. Looks up the AgencyFunction by name in the server's tool map
3. Converts MCP arguments to AgencyFunction's `CallType` format: `{ type: "named", positionalArgs: [], namedArgs: mcpArguments }`
4. Calls `agencyFunction.invoke(callDescriptor, runtimeState)`
5. Wraps the result as MCP tool content:
   - Success: `{ content: [{ type: "text", text: JSON.stringify(result) }] }`
   - Failure (Result type): `{ content: [{ type: "text", text: error }], isError: true }`
   - Rejected interrupt: `{ content: [{ type: "text", text: "Permission denied: <message>" }], isError: true }`

### 8. Runtime Context

Each MCP server process maintains a single RuntimeContext. Each tool call gets state isolation (separate GlobalStore namespace), matching Agency's execution model where each call to a node gets isolated state.

Static variables (declared with the `static` keyword in Agency — see the [execution model docs](../../docs-new/guide/execution-model.md)) are initialized once at server startup and shared across all tool calls. This is correct: static variables are immutable and designed to be shared across runs.

#### Concurrent tool calls

MCP clients may send multiple `tools/call` requests concurrently. The server handles these with async invocation — each call runs in its own state-isolated context. The existing MCP server code (`lib/mcp/server.ts`) handles messages synchronously; the new `agencyServer.ts` must handle `tools/call` asynchronously since `AgencyFunction.invoke()` returns a `Promise`.

#### Functions that make LLM calls

Agency functions exposed as MCP tools may themselves call `llm()`. This is supported — the server process needs LLM configuration (API keys, model settings) available via environment variables or `agency.json`, just like any Agency program. The server does not use MCP sampling for this; it makes LLM calls directly. LLM-calling tools may be slower, which is fine — MCP has no strict timeout requirements, though clients may impose their own.

#### Multi-interrupt functions

A single tool call may hit multiple interrupt points sequentially (e.g., a function that reads a file and then writes a file). The policy handler wraps the entire execution and handles each interrupt as it arises. If the first interrupt is approved by policy but the second is rejected, the function returns a failure at the second interrupt point. Any side effects from before the second interrupt will have already occurred — this matches Agency's normal interrupt behavior, where rejection at any point stops execution going forward but does not roll back prior steps.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  MCP Client                       │
│           (Claude Desktop, Cursor, etc.)          │
└──────────────────┬───────────────────────────────┘
                   │ JSON-RPC over stdio
┌──────────────────▼───────────────────────────────┐
│              Agency MCP Server                    │
│                                                   │
│  ┌─────────────┐  ┌──────────────────────────┐   │
│  │ JSON-RPC    │  │ Tool Registry            │   │
│  │ Handler     │──│  - exported functions     │   │
│  │ (existing)  │  │  - exported PFAs          │   │
│  └──────┬──────┘  │  - manage_policy (builtin)│   │
│         │         └──────────────────────────┘   │
│         │                                         │
│  ┌──────▼──────────────────────────────────────┐ │
│  │ Policy Handler Wrapper                       │ │
│  │                                              │ │
│  │  handle {                                    │ │
│  │    agencyFunction.invoke(args)               │ │
│  │  } with (interrupt) {                        │ │
│  │    decision = checkPolicy(policy, interrupt)  │ │
│  │    if propagate → reject                     │ │
│  │    return decision                           │ │
│  │  }                                           │ │
│  └──────────────────────────────────────────────┘ │
│                                                   │
│  ┌──────────────────────────────────────────────┐ │
│  │ Policy Store                                  │ │
│  │  ~/.agency/mcp/servers/{name}/policy.json     │ │
│  └──────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘
```

## Implementation Components

### New files
- `lib/cli/serve.ts` — CLI command handler for `agency serve`
- `lib/mcp/agencyServer.ts` — Thin composition layer (<100 lines) that wires together tool discovery, the JSON-RPC handler, the policy handler, and the manage_policy tool. Should contain no business logic of its own — just glue.
- `lib/mcp/policyHandler.ts` — Policy loading, merging, and the handler wrapper. Key exports:
  - `resolvePolicy(options) → Policy` — Pure function that loads and merges policies from the resolution chain (CLI flag → user file → default file → empty). Accepts a file reader for testability.
  - `wrapWithPolicy(fn, policy) → fn` — Wraps an AgencyFunction invocation in a policy handler that converts propagate to reject.
- `lib/mcp/managePolicyTool.ts` — Built-in manage_policy tool implementation (list_tools, show_policy, set_policy)
- `lib/mcp/formatResult.ts` — `formatMcpResult(agencyResult) → McpToolResult` — Pure function that maps Agency return values (success, failure Result, rejected interrupt, undefined, JS exceptions) to MCP tool content objects. Keeps all result-formatting logic in one testable place.

### Modified files
- `scripts/agency.ts` — Add `serve` command
- `lib/mcp/server.ts` — Extract shared JSON-RPC infrastructure for reuse
- `lib/runtime/agencyFunction.ts` — Add `exported` and `safe` fields to `AgencyFunctionOpts`
- `lib/backends/typescriptBuilder.ts` — Set `exported` and `safe` on AgencyFunction.create() calls

### Test files
- `lib/mcp/agencyServer.test.ts` — Server startup, tool discovery, invocation
- `lib/mcp/policyHandler.test.ts` — resolvePolicy merging, wrapWithPolicy reject-on-propagate
- `lib/mcp/managePolicyTool.test.ts` — list_tools, show_policy, set_policy operations
- `lib/mcp/formatResult.test.ts` — Result formatting for all Agency return value types

## Future Work

These are explicitly out of scope for this spec but could be added later:

- **HTTP transport** — Streamable HTTP with SSE, session management. Needed for remote/public servers.
- **Server-side OAuth** — Token validation for HTTP transport. Significant work (full OAuth 2.1 server).
- **MCP Resources** — Read-only data exposed to clients. Would need new syntax or conventions for declaring resources.
- **MCP Prompts** — Reusable prompt templates. Low complexity but low demand.
- **Elicitation support** — When MCP clients widely support elicitation, add an `"action": "elicit"` policy action that surfaces interrupts to the user via MCP elicitation instead of auto-approving or rejecting.
- **Default stdlib policies** — Ship recommended policies for stdlib modules (e.g., approve all `std::read`, reject all `std::delete`).
