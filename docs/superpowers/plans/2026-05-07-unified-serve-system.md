# Unified Serve System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users serve Agency functions and nodes over MCP (stdio) or HTTP REST via `agency serve mcp|http`.

**Architecture:** Three layers — shared (compilation, discovery, result formatting, logging), MCP adapter (JSON-RPC, no policies for V1), HTTP adapter (REST routes, auth, interrupt resume). Both adapters consume the same compiled module and exported functions/nodes/static constants.

**Tech Stack:** TypeScript, Node.js built-in `http` module, existing Agency runtime.

**Spec:** `docs/superpowers/specs/2026-05-07-unified-serve-and-http-transport-design.md`

---

## Completed Prerequisites (done in prior PR)

These are already implemented and merged to main:
- `exported` and `safe` fields on `AgencyFunction` (propagated through `partial`/`withToolDefinition`)
- `exported`/`safe` passed through code generation for functions
- `export node` parser support (replaced `visibility`)
- `export static const` parser support (modifiers in any order, typechecker rejects non-static exports)
- Agency generator handles `export` for nodes and assignments
- Shared logger with log levels (`lib/logger.ts`)
- Builder emits `export let` for exported static const variables
- SymbolTable tracks exported static constants

## Key Design Decisions

**No policies for V1.** Interrupts without handlers become failures. Policy-based interrupt handling is deferred.

**Only `export static const` for variables.** The typechecker rejects `export let` and `export const` (without `static`). Static constants live at module scope and are immutable.

**Use existing Result types.** Use `isSuccess`/`isFailure` from `lib/runtime/result.ts`. Interrupts are wrapped in success Results: `{ success: true, value: { interrupts: [...], state: "..." } }`.

**Subcommands.** `agency serve mcp <file>` and `agency serve http <file>` with protocol-specific flags.

**`--standalone` flag.** `agency serve http --standalone` generates a bundled `server.js` via esbuild instead of starting the server.

**Nodes run the full graph.** When a node is called, the graph runs to completion (or until an interrupt fires).

**MCP over HTTP deferred.** The `--http` flag on the MCP subcommand returns "not yet implemented" for V1.

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `lib/serve/types.ts` | Shared types: `ExportedItem` |
| `lib/serve/discovery.ts` | Find exported functions, nodes, and static constants from a compiled module |
| `lib/serve/discovery.test.ts` | Tests for export discovery |
| `lib/serve/mcp/adapter.ts` | MCP JSON-RPC handler (no policies) |
| `lib/serve/mcp/adapter.test.ts` | Tests for MCP adapter |
| `lib/serve/http/adapter.ts` | HTTP server with routes, interrupt-as-response, resume |
| `lib/serve/http/adapter.test.ts` | Tests for HTTP adapter |
| `lib/serve/http/auth.ts` | API key middleware |
| `lib/serve/http/auth.test.ts` | Tests for auth |
| `lib/cli/serve.ts` | CLI entry point: compile, discover, route to adapter |

### Modified files
| File | Change |
|---|---|
| `lib/mcp/server.ts` | Export `startStdioServer` with async handler support |
| `scripts/agency.ts` | Add `serve` command with `mcp` and `http` subcommands |

---

## Task 1: Shared types and export discovery

**Files:**
- Create: `lib/serve/types.ts`
- Create: `lib/serve/discovery.ts`
- Create: `lib/serve/discovery.test.ts`

- [ ] **Step 1: Create shared types**

Create `lib/serve/types.ts`:

```typescript
import type { AgencyFunction } from "../runtime/agencyFunction.js";

export type ExportedFunction = {
  kind: "function";
  name: string;
  description: string;
  agencyFunction: AgencyFunction;
};

export type ExportedNode = {
  kind: "node";
  name: string;
  parameters: Array<{ name: string }>;
  invoke: (args: Record<string, unknown>) => Promise<unknown>;
};

export type ExportedItem = ExportedFunction | ExportedNode;
```

- [ ] **Step 2: Write discovery tests**

Create `lib/serve/discovery.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { discoverExports } from "./discovery.js";
import { AgencyFunction } from "../runtime/agencyFunction.js";

describe("discoverExports", () => {
  it("returns exported functions from tool registry", () => {
    const registry: Record<string, AgencyFunction> = {};
    AgencyFunction.create({
      name: "publicFn", module: "test", fn: async () => {},
      params: [], toolDefinition: { name: "publicFn", description: "A public fn", schema: null },
      exported: true, safe: false,
    }, registry);
    AgencyFunction.create({
      name: "privateFn", module: "test", fn: async () => {},
      params: [], toolDefinition: { name: "privateFn", description: "Private", schema: null },
      exported: false,
    }, registry);

    const exports = discoverExports({ toolRegistry: registry, moduleExports: {} });
    const functions = exports.filter(e => e.kind === "function");
    expect(functions).toHaveLength(1);
    expect(functions[0].name).toBe("publicFn");
  });

  it("returns exported nodes from module exports", () => {
    const mockNodeFn = async () => ({ data: "result" });
    const moduleExports = {
      main: mockNodeFn,
      __mainNodeParams: [{ name: "message" }],
    };

    const exports = discoverExports({
      toolRegistry: {},
      moduleExports,
      exportedNodeNames: ["main"],
    });
    const nodes = exports.filter(e => e.kind === "node");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("main");
  });

  it("returns empty array when no exports found", () => {
    expect(discoverExports({ toolRegistry: {}, moduleExports: {} })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run lib/serve/discovery.test.ts 2>&1 > /tmp/claude/t1-fail.txt && cat /tmp/claude/t1-fail.txt`

- [ ] **Step 4: Implement discovery**

Create `lib/serve/discovery.ts`:

```typescript
import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { ExportedFunction, ExportedNode, ExportedItem } from "./types.js";

type DiscoverOptions = {
  toolRegistry: Record<string, AgencyFunction>;
  moduleExports: Record<string, unknown>;
  exportedNodeNames?: string[];
};

export function discoverExports(options: DiscoverOptions): ExportedItem[] {
  const { toolRegistry, moduleExports, exportedNodeNames = [] } = options;
  const items: ExportedItem[] = [];

  for (const fn of Object.values(toolRegistry)) {
    if (fn.exported && fn.toolDefinition) {
      items.push({
        kind: "function",
        name: fn.name,
        description: fn.toolDefinition.description,
        agencyFunction: fn,
      });
    }
  }

  for (const nodeName of exportedNodeNames) {
    const nodeFn = moduleExports[nodeName];
    if (typeof nodeFn !== "function") continue;
    const paramsKey = `__${nodeName}NodeParams`;
    const params = (moduleExports[paramsKey] as Array<{ name: string }>) ?? [];
    items.push({
      kind: "node",
      name: nodeName,
      parameters: params,
      invoke: nodeFn as (args: Record<string, unknown>) => Promise<unknown>,
    });
  }

  return items;
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/serve/discovery.test.ts 2>&1 > /tmp/claude/t1-pass.txt && cat /tmp/claude/t1-pass.txt`

- [ ] **Step 6: Commit**

```
git add lib/serve/
git commit -m "Add shared types and export discovery for serve system"
```

---

## Task 2: Export startStdioServer from MCP server

**Files:**
- Modify: `lib/mcp/server.ts`

The existing `startMcpServer` in `lib/mcp/server.ts` needs to be exported as a reusable `startStdioServer` that accepts an async handler. The MCP serve adapter will use this.

- [ ] **Step 1: Export helpers and extract startStdioServer**

In `lib/mcp/server.ts`:
- Export the `success`, `error` functions and `JsonRpcMessage` type
- Rename `startMcpServer` to `startAgencyLspMcpServer`
- Extract a generic `startStdioServer(handler)` that accepts a sync or async handler
- Have `startAgencyLspMcpServer` call `startStdioServer(handleMcpMessage)`

- [ ] **Step 2: Update callers**

Search for `startMcpServer` in `scripts/agency.ts` and update to `startAgencyLspMcpServer`.

- [ ] **Step 3: Run MCP server tests**

Run: `pnpm test:run lib/mcp/server.test.ts 2>&1 > /tmp/claude/t2.txt && cat /tmp/claude/t2.txt`

- [ ] **Step 4: Commit**

```
git add lib/mcp/server.ts scripts/agency.ts
git commit -m "Export startStdioServer for reuse by serve system"
```

---

## Task 3: MCP adapter

**Files:**
- Create: `lib/serve/mcp/adapter.ts`
- Create: `lib/serve/mcp/adapter.test.ts`

Simple JSON-RPC handler. No policies for V1 — interrupts without handlers become failures.

- [ ] **Step 1: Write tests**

Create `lib/serve/mcp/adapter.test.ts` with tests for:
- `initialize` response
- `tools/list` returns exported functions
- `tools/call` calls a function and returns formatted result (using Agency Result type)
- Unknown tool returns error

Use `AgencyFunction.create()` to make test functions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/serve/mcp/adapter.test.ts 2>&1 > /tmp/claude/t3-fail.txt && cat /tmp/claude/t3-fail.txt`

- [ ] **Step 3: Implement MCP adapter**

Create `lib/serve/mcp/adapter.ts`. Key design:
- `createMcpHandler(config)` returns an async function `(JsonRpcMessage) → JsonRpcMessage | null`
- Extract `handleToolCall` as a separate function to keep the switch statement clean
- Use `isSuccess`/`isFailure` from `lib/runtime/result.ts` to format results into MCP `content[]` format
- Set `readOnlyHint` annotation for `safe` functions in `tools/list`
- For Zod-to-JSON-Schema: check what Zod version is used and use the appropriate conversion method

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/serve/mcp/adapter.test.ts 2>&1 > /tmp/claude/t3-pass.txt && cat /tmp/claude/t3-pass.txt`

- [ ] **Step 5: Commit**

```
git add lib/serve/mcp/
git commit -m "Add MCP adapter for serve system"
```

---

## Task 4: HTTP auth middleware

**Files:**
- Create: `lib/serve/http/auth.ts`
- Create: `lib/serve/http/auth.test.ts`

- [ ] **Step 1: Write tests**

Test: no key configured = allow all, valid key = allow, wrong/missing key = reject, wrong format = reject.

- [ ] **Step 2: Implement**

```typescript
export function checkAuth(configuredKey: string | undefined, authHeader: string | undefined): boolean {
  if (!configuredKey) return true;
  if (!authHeader) return false;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  return parts[1] === configuredKey;
}
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```
git add lib/serve/http/
git commit -m "Add API key auth for HTTP serve adapter"
```

---

## Task 5: HTTP adapter

**Files:**
- Create: `lib/serve/http/adapter.ts`
- Modify: `lib/serve/http/adapter.test.ts`

HTTP server using Node's built-in `http` module. Routes: `GET /list`, `POST /functions/:name`, `POST /nodes/:name`, `POST /resume`.

- [ ] **Step 1: Write tests**

Test the route handler as a pure function `(method, path, body, authHeader?) → { status, body }`:
- `GET /list` returns manifest
- `POST /functions/:name` calls function, returns Agency Result
- `POST /functions/:name` returns 404 for unknown
- `POST /nodes/:name` calls a node
- `POST /resume` accepts state + responses array
- Auth: 401 when key required but missing, 200 when key valid

- [ ] **Step 2: Implement**

Create `lib/serve/http/adapter.ts`:
- `createHttpHandler(config)` returns the pure handler function for testability
- `startHttpServer(config)` wraps in `http.createServer` with request body parsing
- Use `isSuccess`/`isFailure` from `lib/runtime/result.ts`
- Use `checkAuth` from `./auth.js`
- Use `logRequest` from `lib/logger.ts` (the logger we already built)
- Each request runs in isolation (no shared mutable state)
- `/resume` uses Agency's existing interrupt resume mechanism
- All responses use Agency Result format: `{ success: true, value }` or `{ success: false, error }`
- Interrupts: `{ success: true, value: { interrupts: [...], state: "..." } }`

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```
git add lib/serve/http/
git commit -m "Add HTTP adapter for serve system"
```

---

## Task 6: CLI serve command

**Files:**
- Create: `lib/cli/serve.ts`
- Modify: `scripts/agency.ts`

- [ ] **Step 1: Study existing CLI patterns**

Read:
- `lib/cli/commands.ts` — `compile()` function (takes config, inputFile, returns output path)
- `scripts/agency.ts` — `test` command (lines 276-360) for subcommand pattern
- `lib/cli/util.ts` — `pickANode` for node discovery pattern

- [ ] **Step 2: Implement serve.ts**

Create `lib/cli/serve.ts` with:
- `serveMcp(file, options)` — compile, discover exports, create MCP handler, start stdio server
- `serveHttp(file, options)` — compile, discover exports, start HTTP server
- `compileAndDiscover(file)` — shared function that compiles and discovers exports
- Use static imports (no dynamic imports per CLAUDE.md, except for the compiled module which must be dynamic)
- Node discovery: find `__<name>NodeParams` exports in the compiled module, filter by `exported` flag
- `--standalone` flag: bundle with esbuild into a single `server.js` file

- [ ] **Step 3: Add serve command to scripts/agency.ts**

Add before the default command. Use subcommand pattern:

```typescript
const serveCmd = program
  .command("serve")
  .description("Serve Agency code over MCP or HTTP");

serveCmd
  .command("mcp")
  .description("Start an MCP server (stdio)")
  .argument("<file>", "Agency file to serve")
  .option("--name <name>", "Server name (defaults to filename)")
  .action(async (file, options) => { ... });

serveCmd
  .command("http")
  .description("Start an HTTP REST server")
  .argument("<file>", "Agency file to serve")
  .option("--port <port>", "HTTP port (default: 3000)")
  .option("--api-key <key>", "API key for authentication")
  .option("--standalone", "Generate a standalone server.js file")
  .action(async (file, options) => { ... });
```

- [ ] **Step 4: Verify command registers**

Run: `pnpm run agency serve --help`

- [ ] **Step 5: Commit**

```
git add lib/cli/serve.ts scripts/agency.ts
git commit -m "Add agency serve command with mcp and http subcommands"
```

---

## Task 7: End-to-end smoke test

**Files:**
- Create: `tests/agency/serve-basic.agency`

- [ ] **Step 1: Create test Agency file**

```typescript
export safe def add(a: number, b: number): number {
  """
  Adds two numbers together.
  @param a - First number
  @param b - Second number
  """
  return a + b
}

export safe def greet(name: string): string {
  """Greets someone by name."""
  return "Hello, ${name}!"
}

def internal(): string {
  return "not exported"
}
```

- [ ] **Step 2: Test MCP tools/list**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | pnpm run agency serve mcp tests/agency/serve-basic.agency 2>/dev/null
```

Expected: Tools list with `add` and `greet`. Should NOT include `internal`.

- [ ] **Step 3: Test HTTP server**

Start server in one terminal, curl in another:
```bash
curl -s http://localhost:3000/list | jq .
curl -s -X POST http://localhost:3000/functions/add -H 'Content-Type: application/json' -d '{"a":3,"b":4}' | jq .
```

Expected: `/list` returns manifest. `/functions/add` returns `{ "success": true, "value": 7 }`.

- [ ] **Step 4: Commit**

```
git add tests/agency/serve-basic.agency
git commit -m "Add end-to-end test fixture for serve system"
```

---

## Task 8: Documentation

**Files:**
- Create or modify: `docs-new/guide/serving.md`

- [ ] **Step 1: Write serving guide**

Cover:
- `agency serve mcp` and `agency serve http` commands with all flags
- How `export def`, `export node`, `export static const` control what's served
- HTTP routes and response format (Agency Result types)
- Interrupt handling over HTTP (interrupt response + `/resume`)
- API key auth
- `--standalone` for bundled deployment
- Examples

- [ ] **Step 2: Commit**

```
git add docs-new/guide/serving.md
git commit -m "Add documentation for serving Agency code"
```
