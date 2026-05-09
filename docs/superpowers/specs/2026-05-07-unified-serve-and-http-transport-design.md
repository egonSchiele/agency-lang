# Unified Serve System and HTTP Transport

## Overview

Agency programs can be served over multiple protocols, letting users write their agent once and expose it to LLM clients (via MCP) or to apps, scripts, and other services (via HTTP). This spec defines a unified serve system with three layers:

1. **User-facing conventions** — `export def`, `export node`, and `export const` mark what gets served, policies control MCP interrupt handling, one CLI command starts the server.
2. **Shared implementation** — compilation, export discovery, result formatting, logging.
3. **Protocol adapters** — MCP adapter (JSON-RPC over stdio) and HTTP adapter (REST over HTTP).

This spec supersedes the MCP-only spec at `docs/superpowers/specs/2026-05-06-agency-mcp-server-design.md`. All MCP-specific behavior from that spec is preserved and moved under the MCP adapter. This spec adds the HTTP adapter and the shared layer that both adapters use.

## Goals

1. Single CLI command to serve Agency code over MCP or HTTP
2. Shared compilation, discovery, and logging across both transports
3. HTTP transport with stateless REST API: call functions/nodes, receive interrupts, resume execution
4. Clean separation between shared code and protocol-specific code so MCP and HTTP can diverge freely
5. Optional API key auth for HTTP

## Non-goals

- Server-side state or sessions (stateless model — client manages state)
- SSE streaming (future work)
- Web UI / Studio (future work)
- Re-export syntax for multi-file agents (future language feature)
- Versioning (not needed for MVP)
- Policies for HTTP (interrupts go directly to the client)

## Architecture

### Layer 1: User-Facing Conventions (Shared)

Users control what gets served using the existing `export` keyword:

```typescript
// Exported function — becomes a server endpoint
export def summarize(text: string): string {
  return llm("Summarize: ${text}")
}

// Exported node — also becomes a server endpoint
export node categorize(message: string) {
  const category: Category = llm("Categorize: ${message}")
  return category
}

// Exported static const — PFA becomes a server endpoint with constrained parameters
export static const readFromSafe = readFile.partial(dir: "/safe")

// Not exported — internal only
def helper(): string {
  return "internal"
}
```

Only `export static const` declarations can be exported — not `export let` or `export const` (the typechecker enforces this). Static constants live at module scope and are immutable, which makes them safe to serve and import across files. This is primarily useful for exporting partially applied functions (PFAs) as constrained tools.

For multi-file agents, the entrypoint file is the manifest. Only functions and nodes with `export` in the file passed to `agency serve` become endpoints. Imported functions are available internally but not exposed. Users who want to expose functions from other files can write thin wrappers in the entrypoint:

```typescript
import { summarize } from "./tools.agency"

export def summarizeText(text: string): string {
  return summarize(text)
}
```

Re-export syntax (`export { foo } from "./bar.agency"`) is a future language feature that would eliminate these wrappers.

### Layer 2: Shared Implementation

#### CLI entry point

```bash
agency serve mcp <file.agency> [mcp-options]
agency serve http <file.agency> [http-options]
```

`mcp` and `http` are subcommands, each with their own flags:

**Shared options (both subcommands):**
- `--name <name>` — Server name. Defaults to filename without extension.

**MCP-specific options:**
- `--policy <path>` — Path to policy JSON file.
- `--http <port>` — Serve MCP over HTTP (Streamable HTTP transport) instead of stdio.

**HTTP-specific options:**
- `--port <port>` — HTTP port. Defaults to `3000`.
- `--api-key <key>` — API key for authentication. Can also be set via `AGENCY_API_KEY` env var.

Examples:
```bash
agency serve mcp myagent.agency                    # MCP over stdio
agency serve mcp myagent.agency --http 3001         # MCP over HTTP
agency serve http myagent.agency --port 3000        # REST API
agency serve http myagent.agency --api-key secret   # REST API with auth
```

Both subcommands:
1. Compile the Agency file. If compilation fails, print the error to stderr and exit with a non-zero code.
2. Discover all exported functions, nodes, and constants.
3. Set up logging.
4. Start the appropriate transport adapter.

#### Export discovery

Both functions and nodes can be exported. The server discovers them by walking the tool registry after compilation. Both MCP and HTTP adapters use the same discovery function.

Nodes need to be discoverable alongside functions. The `exported` flag added to `AgencyFunction` in the MCP spec also needs to be added to compiled nodes. The discovery function returns a list of exports, each tagged as either a function or a node.

#### Result formatting

The shared layer produces standard Agency Result types — no custom format. All results use Agency's existing `Result` type:

- Success: `{ success: true, value: <value> }`
- Failure: `{ success: false, error: <message> }`
- Interrupted: `{ success: true, value: { interrupts: [...], state: <serialized> } }`

Interrupts are wrapped in a success Result because the execution itself succeeded — it just paused. The `interrupts` field is always an array because Agency supports concurrent interrupts (multiple interrupts fired simultaneously from parallel threads).

Each protocol adapter translates from these standard Result types into its own wire format. The MCP adapter wraps results in MCP's `content[]` array with `isError`. The HTTP adapter sends the Result directly as JSON.

Note: the serialized execution state returned on interrupt is called "state" (not "checkpoint") to avoid confusion with Agency's existing `checkpoint()` function, which is a different feature for snapshotting and rollback within a single execution.

#### Logging

Structured request/response logging to stderr for both transports:

```
[2026-05-07 14:32:01] POST /functions/summarize → 200 (342ms)
[2026-05-07 14:32:05] tools/call greet → success (120ms)
```

Logs include: timestamp, what was called, result status, duration. Goes to stderr so it doesn't interfere with stdio (for MCP) or HTTP responses.

#### Runtime isolation

Both adapters need the same isolation guarantee: each call runs in its own RuntimeContext with an isolated GlobalStore namespace. Static variables (declared with `static` in Agency) are initialized once at server startup and shared immutably across all calls. This is shared-layer behavior, not protocol-specific.

### Layer 3: Protocol Adapters

#### MCP Adapter

All MCP-specific behavior from the original MCP spec is preserved here:

- **Transport:** JSON-RPC over stdio (default) or Streamable HTTP (with `--http <port>`)
- **Tool discovery:** `tools/list` returns all exported functions (not nodes — MCP tools are stateless)
- **Tool invocation:** `tools/call` calls a function, returns result wrapped in MCP's `content[]` format
- **Interrupt handling:** Policies gate interrupts. Propagate becomes reject. If no policy covers an interrupt, it is rejected.
- **`managePolicy` tool:** Built-in tool for configuring policies interactively via the LLM client. Supports `listTools`, `showPolicy`, `setPolicy` operations. Uses camelCase to match Agency's JavaScript conventions.
- **Policy storage:** `~/.agency/mcp/servers/{name}/policy.json`
- **Annotations:** `readOnlyHint` set for `safe` functions
- **Future:** Elicitation support, MCP Resources, Prompts

The `managePolicy` tool uses `getPolicy`/`setPolicy` callbacks rather than a shared mutable reference. The mutable state lives in one place inside the adapter.

**MCP over HTTP:** When started with `--http <port>`, the MCP adapter serves the same JSON-RPC protocol over Streamable HTTP instead of stdio. The MCP adapter logic (policy handling, tool listing, tool calling) is identical — only the transport layer changes. This reuses the same HTTP server infrastructure as the HTTP adapter.

For details on policy structure, merging, and the managePolicy tool, see the original MCP spec.

#### HTTP Adapter

**Routes:**

| Route | Method | Purpose |
|---|---|---|
| `GET /list` | GET | JSON manifest of all exported functions and nodes |
| `POST /functions/:name` | POST | Call an exported function |
| `POST /nodes/:name` | POST | Call an exported node |
| `POST /resume` | POST | Resume execution from an interrupt |

**Calling a function or node:**

```
POST /functions/summarize
Content-Type: application/json

{ "text": "some long article..." }
```

Response:
```json
{ "success": true, "value": "A short summary..." }
```

**When an interrupt fires:**

```json
{
  "success": true,
  "value": {
    "interrupts": [
      {
        "kind": "std::delete",
        "message": "Are you sure you want to delete 1M emails?",
        "data": { "numEmails": 1000000 }
      }
    ],
    "state": "<serialized execution state>"
  }
}
```

The client decides how to handle each interrupt and resumes:

```
POST /resume
Content-Type: application/json

{
  "state": "<serialized execution state>",
  "responses": ["approve"]
}
```

Or with data:
```json
{
  "state": "<serialized execution state>",
  "responses": [{ "filename": "output.txt" }]
}
```

The `responses` array corresponds positionally to the `interrupts` array — each response handles the interrupt at the same index.

**Failures:**

```json
{ "success": false, "error": "Number must be even to be halved, got 5" }
```

**The `/list` endpoint:**

Returns a JSON manifest of all exported functions and nodes:

```json
{
  "functions": [
    {
      "name": "summarize",
      "description": "Summarizes text",
      "parameters": { "text": { "type": "string" } }
    }
  ],
  "nodes": [
    {
      "name": "categorize",
      "description": "Categorizes a message",
      "parameters": { "message": { "type": "string" } }
    }
  ]
}
```

**Status codes:**

- `200` — for everything that executed (success, failure, interrupted)
- `400` — malformed request body
- `401` — bad or missing API key (only when auth is enabled)
- `404` — unknown function or node name

**Authentication:**

Optional API key authentication. Enabled by passing `--api-key <key>` or setting `AGENCY_API_KEY` env var. When enabled, every request must include:

```
Authorization: Bearer <key>
```

Requests without a valid key receive `401`. When auth is not configured, all requests are accepted.

**No policies for HTTP.** Unlike MCP, the HTTP adapter does not use policies. Interrupts are always returned to the client. The client is responsible for deciding how to respond.

**Stateless model.** The server holds no state between requests. Each function/node call runs in an isolated RuntimeContext. When an interrupt occurs, the full execution state is serialized and returned to the client. The client must send the state back via `/resume` to continue execution. This means multiple clients can hit the same server without state conflicts.

**How `/resume` works:**

The serialized state is opaque to the client. The server uses Agency's existing interrupt resume mechanism to continue execution from where it left off. The compiled module is already loaded in memory from server startup — no recompilation is needed.

The server wraps resumed execution in the same interrupt-returning handler it uses for initial calls, so if further interrupts fire during resumed execution, they are returned as another interrupt response. The response format for `/resume` is identical to an initial call: success, failure, or interrupt.

**Duplicate resume requests:** Because the server is stateless, nothing prevents a client from sending the same execution state to `/resume` multiple times. Each call re-executes from the interrupt point, which could cause duplicate side effects. This is an accepted limitation of the stateless model — the client is responsible for not resuming the same state twice.

**Corrupted or tampered state:** The serialized state is an opaque blob from the client's perspective. If it is malformed or from a different version of the Agency file, deserialization will fail and the server returns a `400` error. For the MVP, there is no integrity verification (e.g., HMAC signing). This is acceptable for trusted clients (your own apps/scripts) but should be addressed before exposing to untrusted clients. Added to Future Work.

**Node execution semantics:** When a node is called via `POST /nodes/:name`, the server executes the full graph starting at that node. If the node transitions to other nodes, the graph runs to completion (or until an interrupt fires). This matches how nodes work when called from TypeScript — a node call is a permanent transition that runs the graph until it finishes.

## File Structure

### Shared code (new directory: `lib/serve/`)
| File | Responsibility |
|---|---|
| `lib/serve/discovery.ts` | Export discovery: find exported functions and nodes from compiled module |
| `lib/serve/formatResult.ts` | Protocol-neutral result formatting |
| `lib/serve/logging.ts` | Structured request/response logging to stderr |
| `lib/serve/types.ts` | Shared types |
| `lib/cli/serve.ts` | CLI entry point: compile, discover, route to adapter |

### MCP adapter (moved from `lib/mcp/` to `lib/serve/mcp/`)
| File | Responsibility |
|---|---|
| `lib/serve/mcp/adapter.ts` | JSON-RPC handler, policy wrapping, tool registration |
| `lib/serve/mcp/policyHandler.ts` | Policy loading, merging, interrupt→reject conversion |
| `lib/serve/mcp/managePolicyTool.ts` | Built-in managePolicy tool |

### HTTP adapter (new)
| File | Responsibility |
|---|---|
| `lib/serve/http/adapter.ts` | HTTP server, route generation, interrupt-as-response |
| `lib/serve/http/auth.ts` | API key middleware |

### Existing MCP code (unchanged)
| File | Responsibility |
|---|---|
| `lib/mcp/server.ts` | IDE/LSP MCP server (completely separate from the serve system) |
| `lib/mcp/tools.ts` | IDE MCP tools (diagnostics, hover, etc.) |

### Modified files
| File | Change |
|---|---|
| `lib/runtime/agencyFunction.ts` | Add `exported` and `safe` fields (from MCP spec) |
| `lib/backends/typescriptBuilder.ts` | Pass `exported` and `safe` into AgencyFunction.create() |
| `lib/runtime/policy.ts` | Export `Policy` and `PolicyRule` types |
| `scripts/agency.ts` | Add `serve` command |

Note: The existing `lib/mcp/server.ts` (IDE/LSP MCP server) stays where it is and is not modified. The MCP serve adapter (`lib/serve/mcp/adapter.ts`) implements its own JSON-RPC handling. Shared JSON-RPC utilities (if needed) live in `lib/serve/types.ts`.

## Future Work

- **SSE streaming** — Stream LLM token output for HTTP transport
- **Re-export syntax** — `export { foo } from "./bar.agency"` to avoid wrapper functions
- **Web UI / Studio** — Visual interface for interacting with a served agent, built on top of the HTTP API
- **MCP elicitation** — When clients support it, surface interrupts via MCP elicitation
- **MCP resources and prompts** — Additional MCP capabilities
- **Cross-file PFA import** — `export static const` values are served and importable as JS identifiers, but the SymbolTable does not yet analyze PFA expressions to determine their reduced parameter signature. Cross-file type checking of PFA calls requires static analysis of `.partial()` expressions.
- **Node parameter schemas** — Expose node parameter types in `/list` (requires extending node compilation)
- **Checkpoint integrity** — HMAC signing of serialized state for `/resume` to prevent tampering by untrusted clients
- **CORS headers** — Needed if the HTTP server is called from browser-based clients
- **HTTP timeouts** — Configurable timeouts for long-running LLM calls; for now the client manages timeouts
