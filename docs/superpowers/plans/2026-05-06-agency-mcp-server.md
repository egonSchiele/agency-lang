# Agency MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users expose Agency functions as MCP tools via `agency serve`, with policy-based interrupt handling.

**Architecture:** Compile an Agency file, discover exported AgencyFunctions, and serve them as MCP tools over stdio. Interrupts are handled by policies (propagate → reject). A built-in `manage_policy` tool lets LLM clients help users configure permissions.

**Tech Stack:** TypeScript, Zod (JSON Schema conversion), existing MCP JSON-RPC infrastructure, existing policy runtime.

**Spec:** `docs/superpowers/specs/2026-05-06-agency-mcp-server-design.md`

---

## Prerequisites / Out of Scope

**`export const` for PFAs:** The spec calls for `export const readFromSafe = readFile.partial(dir: "/safe")`. The parser does not currently support `export const` — the `Assignment` type has no `exported` field. This is a separate language feature that requires parser, AST, builder, and test changes. It should be implemented before or alongside this plan, but is not included here because it is a general language feature, not MCP-specific. Until `export const` is supported, users can only export functions via `export def`.

**Full RuntimeContext interrupt handler integration:** Wiring `handleInterruptWithPolicy` into Agency's handler chain requires understanding how `setupNode`/`setupFunction` in `lib/runtime/node.ts` push handlers onto `__ctx.handlers`. This plan implements all the building blocks (policy resolution, interrupt decision function, result formatting) but the actual wiring into RuntimeContext needs investigation during Task 7. The plan includes a research step for this. Without this wiring, functions with interrupts will fail with uncaught interrupt errors (effectively "reject by default"), which is safe but not the full policy experience.

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `lib/mcp/types.ts` | Shared types: `Policy`, `McpToolResult` |
| `lib/mcp/formatResult.ts` | Pure function: Agency result → MCP tool content |
| `lib/mcp/formatResult.test.ts` | Tests for result formatting |
| `lib/mcp/policyHandler.ts` | Pure functions: policy loading/merging, interrupt decision |
| `lib/mcp/policyHandler.test.ts` | Tests for policy resolution and interrupt handling |
| `lib/mcp/managePolicyTool.ts` | Built-in manage_policy tool (list_tools, show_policy, set_policy) |
| `lib/mcp/managePolicyTool.test.ts` | Tests for manage_policy operations |
| `lib/mcp/agencyServer.ts` | Thin composition layer: wires tool discovery, JSON-RPC, policy handler, manage_policy |
| `lib/mcp/agencyServer.test.ts` | Integration tests for the full server |
| `lib/cli/serve.ts` | CLI command handler for `agency serve` |

### Modified files
| File | Change |
|---|---|
| `lib/runtime/agencyFunction.ts` | Add `exported` and `safe` fields; propagate through `partial()`, `withToolDefinition()`, `describe()` |
| `lib/runtime/policy.ts` | Export `Policy` and `PolicyRule` types |
| `lib/backends/typescriptBuilder.ts` | Pass `exported` and `safe` into `AgencyFunction.create()` calls |
| `lib/mcp/server.ts` | Export JSON-RPC helpers (`success`, `error`, types); extract `startStdioServer` |
| `scripts/agency.ts` | Add `serve` command |

---

## Task 1: Add `exported` and `safe` fields to AgencyFunction

**Files:**
- Modify: `lib/runtime/agencyFunction.ts:25-55, 70-78, 98-141, 144-149`

- [ ] **Step 1: Add fields to AgencyFunctionOpts type**

In `lib/runtime/agencyFunction.ts`, add two optional fields to the `AgencyFunctionOpts` type (lines 25-31):

```typescript
export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: Function;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
  exported?: boolean;
  safe?: boolean;
};
```

- [ ] **Step 2: Store fields in the constructor**

Add readonly fields to the class (after line 43) and set them in the constructor (after line 50):

```typescript
// Add to class fields (after line 43):
readonly exported: boolean;
readonly safe: boolean;

// Add to constructor (after line 50):
this.exported = opts.exported ?? false;
this.safe = opts.safe ?? false;
```

- [ ] **Step 3: Propagate fields through `withToolDefinition()`**

Update `withToolDefinition()` (lines 70-78) to pass `exported` and `safe`:

```typescript
withToolDefinition(toolDefinition: ToolDefinition | null): AgencyFunction {
    return new AgencyFunction({
      name: this.name,
      module: this.module,
      fn: this._fn,
      params: this.params,
      toolDefinition,
      exported: this.exported,
      safe: this.safe,
    });
}
```

- [ ] **Step 4: Propagate fields through `partial()`**

Update the `return new AgencyFunction(...)` call in `partial()` (lines 135-141):

```typescript
return new AgencyFunction({
  name: this.name,
  module: this.module,
  fn: this._fn,
  params: newParams,
  toolDefinition: newToolDef,
  exported: this.exported,
  safe: this.safe,
});
```

- [ ] **Step 5: Run existing tests to verify nothing breaks**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/task1-tests.txt && cat /tmp/claude/task1-tests.txt`

Expected: All existing tests pass (the new fields are optional with defaults).

- [ ] **Step 6: Commit**

```
git add lib/runtime/agencyFunction.ts
git commit -m "Add exported and safe fields to AgencyFunction, propagated through partial/describe"
```

---

## Task 2: Pass `exported` and `safe` through code generation

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1886-1902`
- Modify: `lib/compilationUnit.ts` (read-only reference for `safeFunctions`)

- [ ] **Step 1: Add `safe` and `exported` to the AgencyFunction.create() call in processFunction**

In `lib/backends/typescriptBuilder.ts`, find the `ts.obj` call inside `processFunction` (around line 1890). Add both fields:

```typescript
const createCall = $
  .id("__AgencyFunction")
  .prop("create")
  .call([
    ts.obj({
      name: ts.str(functionName),
      module: ts.str(this.moduleId),
      fn: ts.id(implName),
      params: ts.arr(paramNodes),
      toolDefinition: toolDef,
      safe: ts.bool(!!this.compilationUnit.safeFunctions[functionName]),
      exported: ts.bool(!!node.exported),
    }),
    ts.id("__toolRegistry"),
  ])
  .done();
```

The `node.exported` flag already exists on `FunctionDefinition` (see `lib/types/function.ts:53`). The `safeFunctions` record is in `compilationUnit.ts:89`.

- [ ] **Step 2: Run existing tests**

Run: `pnpm test:run 2>&1 | tail -20 > /tmp/claude/task2-tests.txt && cat /tmp/claude/task2-tests.txt`

Expected: All existing tests pass.

- [ ] **Step 3: Verify with a compiled fixture**

Pick any existing test fixture and compile it to verify the output includes the new fields:

Run: `pnpm run compile tests/typescriptGenerator/functions.agency 2>&1 | grep -A2 "safe\|exported" | head -20`

Expected: The compiled output should include `safe: false` and `exported: false` (or `true` where applicable).

- [ ] **Step 4: Commit**

```
git add lib/backends/typescriptBuilder.ts
git commit -m "Pass exported and safe flags to AgencyFunction.create()"
```

---

## Task 3: Export shared types and extract JSON-RPC helpers

**Files:**
- Create: `lib/mcp/types.ts`
- Modify: `lib/runtime/policy.ts:3-8`
- Modify: `lib/mcp/server.ts:14-25, 125-227`

- [ ] **Step 1: Export Policy types from policy.ts**

In `lib/runtime/policy.ts`, the `PolicyRule`, `Policy`, and `PolicyResult` types are module-private. Export them:

```typescript
export type PolicyRule = {
  match?: Record<string, string>;
  action: "approve" | "reject" | "propagate";
};

export type Policy = Record<string, PolicyRule[]>;

export type PolicyResult =
  | { type: "approve" }
  | { type: "reject" }
  | { type: "propagate" };
```

- [ ] **Step 2: Create shared MCP types file**

Create `lib/mcp/types.ts`:

```typescript
export type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
};
```

- [ ] **Step 3: Export JSON-RPC helpers from server.ts**

In `lib/mcp/server.ts`, export the `success` (line 125), `error` (line 128) functions and the `JsonRpcId`, `JsonRpcMessage` types:

```typescript
export type JsonRpcId = string | number | null;

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

export function success(id: JsonRpcId, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

export function error(id: JsonRpcId, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
```

- [ ] **Step 4: Extract startStdioServer as a reusable function**

Rename `startMcpServer` to `startAgencyLspMcpServer`. Extract a generic `startStdioServer` that accepts an async handler:

```typescript
export function startStdioServer(
  handler: (message: JsonRpcMessage) => JsonRpcMessage | null | Promise<JsonRpcMessage | null>,
): void {
  process.stdin.setEncoding("utf-8");

  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const result = handler(JSON.parse(line));
          const respond = (response: JsonRpcMessage | null) => {
            if (response) {
              process.stdout.write(`${JSON.stringify(response)}\n`);
            }
          };
          if (result && typeof (result as any).then === "function") {
            (result as Promise<JsonRpcMessage | null>).then(respond);
          } else {
            respond(result as JsonRpcMessage | null);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stdout.write(
            `${JSON.stringify(error(null, -32700, `Invalid JSON input: ${message}`))}\n`,
          );
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
}

export function startAgencyLspMcpServer(): void {
  startStdioServer(handleMcpMessage);
}
```

- [ ] **Step 5: Update callers of the old name**

Search for `startMcpServer` in `scripts/agency.ts` and update to `startAgencyLspMcpServer`.

Run: `grep -rn "startMcpServer" scripts/ lib/ --include="*.ts" | grep -v test | grep -v ".d.ts"`

Update all references.

- [ ] **Step 6: Run existing MCP server tests**

Run: `pnpm test:run lib/mcp/server.test.ts 2>&1 > /tmp/claude/task3-tests.txt && cat /tmp/claude/task3-tests.txt`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```
git add lib/mcp/types.ts lib/runtime/policy.ts lib/mcp/server.ts scripts/agency.ts
git commit -m "Export shared types and extract reusable JSON-RPC helpers"
```

---

## Task 4: Implement formatMcpResult

**Files:**
- Create: `lib/mcp/formatResult.ts`
- Create: `lib/mcp/formatResult.test.ts`
- Reference: `lib/mcp/types.ts` (for `McpToolResult`)

This is a pure function that maps Agency return values to MCP tool content objects.

- [ ] **Step 1: Investigate rejected interrupt result shape**

Before writing tests, check what shape a rejected interrupt actually produces at runtime. Read:
- `lib/runtime/interrupts.ts` — look for what `reject()` returns
- `lib/runtime/node.ts` — look for how rejected interrupts become return values
- Any existing interrupt test fixtures in `tests/agency/`

Document the actual shape so the tests match reality.

- [ ] **Step 2: Write the tests**

Create `lib/mcp/formatResult.test.ts`. Adjust the rejected interrupt test to match the actual shape found in Step 1:

```typescript
import { describe, expect, it } from "vitest";
import { formatMcpResult } from "./formatResult.js";

describe("formatMcpResult", () => {
  it("formats a plain value as success", () => {
    const result = formatMcpResult("hello");
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify("hello") }],
      isError: false,
    });
  });

  it("formats an object as success", () => {
    const result = formatMcpResult({ x: 1, y: 2 });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ x: 1, y: 2 }) }],
      isError: false,
    });
  });

  it("formats undefined as success with null", () => {
    const result = formatMcpResult(undefined);
    expect(result).toEqual({
      content: [{ type: "text", text: "null" }],
      isError: false,
    });
  });

  it("formats a success Result as success with unwrapped value", () => {
    const result = formatMcpResult({ success: true, value: 42 });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(42) }],
      isError: false,
    });
  });

  it("formats a failure Result as error", () => {
    const result = formatMcpResult({ success: false, error: "something went wrong" });
    expect(result).toEqual({
      content: [{ type: "text", text: "something went wrong" }],
      isError: true,
    });
  });

  // NOTE: Adjust this test based on the actual rejected interrupt shape found in Step 1
  it("formats a rejected interrupt failure as permission denied", () => {
    // The exact shape depends on what reject() produces in the runtime
    const result = formatMcpResult({
      success: false,
      error: "Interrupt rejected",
      interruptRejected: true,
      message: "Are you sure you want to delete this file?",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run lib/mcp/formatResult.test.ts 2>&1 > /tmp/claude/task4-fail.txt && cat /tmp/claude/task4-fail.txt`

Expected: FAIL — module not found.

- [ ] **Step 4: Implement formatMcpResult**

Create `lib/mcp/formatResult.ts`:

```typescript
import type { McpToolResult } from "./types.js";

function isResult(value: unknown): value is { success: boolean; value?: unknown; error?: unknown } {
  return typeof value === "object" && value !== null && "success" in value;
}

function isRejectedInterrupt(value: unknown): value is { interruptRejected: true; message: string } {
  return typeof value === "object" && value !== null && (value as any).interruptRejected === true;
}

export function formatMcpResult(value: unknown): McpToolResult {
  if (isResult(value)) {
    if (value.success) {
      return {
        content: [{ type: "text", text: JSON.stringify(value.value) }],
        isError: false,
      };
    }

    if (isRejectedInterrupt(value)) {
      return {
        content: [{ type: "text", text: `Permission denied: ${(value as any).message}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: String(value.error) }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(value ?? null) }],
    isError: false,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run lib/mcp/formatResult.test.ts 2>&1 > /tmp/claude/task4-pass.txt && cat /tmp/claude/task4-pass.txt`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add lib/mcp/formatResult.ts lib/mcp/formatResult.test.ts
git commit -m "Add formatMcpResult for Agency result to MCP content conversion"
```

---

## Task 5: Implement policyHandler

**Files:**
- Create: `lib/mcp/policyHandler.ts`
- Create: `lib/mcp/policyHandler.test.ts`
- Reference: `lib/runtime/policy.ts` (for `checkPolicy`, `validatePolicy`, `Policy` type)

Two pure functions: `resolvePolicy` (loads and merges policies) and `handleInterruptWithPolicy` (decides approve/reject, converting propagate to reject).

- [ ] **Step 1: Write resolvePolicy tests**

Create `lib/mcp/policyHandler.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolvePolicy, handleInterruptWithPolicy } from "./policyHandler.js";

describe("resolvePolicy", () => {
  it("returns empty policy when no sources exist", () => {
    const policy = resolvePolicy({
      readFile: () => null,
    });
    expect(policy).toEqual({});
  });

  it("loads from explicit path", () => {
    const expected = { "std::read": [{ action: "approve" as const }] };
    const policy = resolvePolicy({
      cliPolicyPath: "/explicit/policy.json",
      readFile: (p) => (p === "/explicit/policy.json" ? JSON.stringify(expected) : null),
    });
    expect(policy).toEqual(expected);
  });

  it("loads from user-level path when no CLI path given", () => {
    const expected = { "std::read": [{ action: "approve" as const }] };
    const policy = resolvePolicy({
      serverName: "my-server",
      readFile: (p) =>
        p.endsWith("my-server/policy.json") ? JSON.stringify(expected) : null,
    });
    expect(policy).toEqual(expected);
  });

  it("loads from default path when no user-level policy exists", () => {
    const expected = { "std::write": [{ action: "reject" as const }] };
    const policy = resolvePolicy({
      serverName: "my-server",
      defaultPolicyPath: "/project/policy.json",
      readFile: (p) => (p === "/project/policy.json" ? JSON.stringify(expected) : null),
    });
    expect(policy).toEqual(expected);
  });

  it("merges user policy over default per-kind (full replacement)", () => {
    const defaultPolicy = {
      "std::read": [{ action: "approve" as const }],
      "std::write": [{ action: "reject" as const }],
    };
    const userPolicy = {
      "std::read": [{ match: { path: "src/**" }, action: "approve" as const }, { action: "reject" as const }],
    };
    const policy = resolvePolicy({
      serverName: "my-server",
      defaultPolicyPath: "/project/policy.json",
      readFile: (p) => {
        if (p.endsWith("my-server/policy.json")) return JSON.stringify(userPolicy);
        if (p === "/project/policy.json") return JSON.stringify(defaultPolicy);
        return null;
      },
    });
    expect(policy["std::read"]).toEqual(userPolicy["std::read"]);
    expect(policy["std::write"]).toEqual(defaultPolicy["std::write"]);
  });
});
```

- [ ] **Step 2: Write handleInterruptWithPolicy tests**

Add to `lib/mcp/policyHandler.test.ts`:

```typescript
describe("handleInterruptWithPolicy", () => {
  const interrupt = { kind: "std::read", message: "Read file?", data: { path: "src/foo.ts" }, origin: "std::fs" };

  it("approves when policy matches with approve", () => {
    const policy = { "std::read": [{ match: { path: "src/**" }, action: "approve" as const }] };
    expect(handleInterruptWithPolicy(policy, interrupt)).toEqual({ type: "approve" });
  });

  it("rejects when policy matches with reject", () => {
    const policy = { "std::read": [{ action: "reject" as const }] };
    expect(handleInterruptWithPolicy(policy, interrupt)).toEqual({ type: "reject" });
  });

  it("converts propagate to reject (no matching kind)", () => {
    expect(handleInterruptWithPolicy({}, interrupt)).toEqual({ type: "reject" });
  });

  it("converts propagate to reject (no matching rule)", () => {
    const policy = { "std::read": [{ match: { path: "docs/**" }, action: "approve" as const }] };
    expect(handleInterruptWithPolicy(policy, interrupt)).toEqual({ type: "reject" });
  });

  it("converts explicit propagate action to reject", () => {
    const policy = { "std::read": [{ action: "propagate" as const }] };
    expect(handleInterruptWithPolicy(policy, interrupt)).toEqual({ type: "reject" });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run lib/mcp/policyHandler.test.ts 2>&1 > /tmp/claude/task5-fail.txt && cat /tmp/claude/task5-fail.txt`

Expected: FAIL — module not found.

- [ ] **Step 4: Implement policyHandler.ts**

Create `lib/mcp/policyHandler.ts`:

```typescript
import os from "os";
import path from "path";
import { checkPolicy, validatePolicy, type Policy } from "../runtime/policy.js";

type ResolvePolicyOptions = {
  cliPolicyPath?: string;
  serverName?: string;
  defaultPolicyPath?: string;
  readFile: (path: string) => string | null;
};

function loadPolicy(filePath: string, readFile: (p: string) => string | null): Policy | null {
  const content = readFile(filePath);
  if (content === null) return null;
  const parsed = JSON.parse(content);
  const validation = validatePolicy(parsed);
  if (!validation.success) {
    throw new Error(`Invalid policy at ${filePath}: ${validation.error}`);
  }
  return parsed;
}

export function resolvePolicy(options: ResolvePolicyOptions): Policy {
  const { cliPolicyPath, serverName, defaultPolicyPath, readFile } = options;

  if (cliPolicyPath) {
    return loadPolicy(cliPolicyPath, readFile) ?? {};
  }

  const userPolicyPath = serverName
    ? path.join(os.homedir(), ".agency", "mcp", "servers", serverName, "policy.json")
    : undefined;
  const userPolicy = userPolicyPath ? loadPolicy(userPolicyPath, readFile) : null;

  const defaultPolicy = defaultPolicyPath ? loadPolicy(defaultPolicyPath, readFile) : null;

  if (userPolicy && defaultPolicy) {
    return { ...defaultPolicy, ...userPolicy };
  }

  return userPolicy ?? defaultPolicy ?? {};
}

export function handleInterruptWithPolicy(
  policy: Policy,
  interrupt: { kind: string; message: string; data: any; origin: string },
): { type: "approve" } | { type: "reject" } {
  const decision = checkPolicy(policy, interrupt);
  if (decision.type === "propagate") {
    return { type: "reject" };
  }
  return decision as { type: "approve" } | { type: "reject" };
}
```

- [ ] **Step 5: Run all policyHandler tests**

Run: `pnpm test:run lib/mcp/policyHandler.test.ts 2>&1 > /tmp/claude/task5-pass.txt && cat /tmp/claude/task5-pass.txt`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add lib/mcp/policyHandler.ts lib/mcp/policyHandler.test.ts
git commit -m "Add policyHandler with resolvePolicy and handleInterruptWithPolicy"
```

---

## Task 6: Implement managePolicyTool

**Files:**
- Create: `lib/mcp/managePolicyTool.ts`
- Create: `lib/mcp/managePolicyTool.test.ts`
- Reference: `lib/mcp/types.ts` (for `McpToolResult`)
- Reference: `lib/runtime/policy.ts` (for `validatePolicy`, `Policy` type)

Three operations: `list_tools`, `show_policy`, `set_policy`.

- [ ] **Step 1: Write tests**

Create `lib/mcp/managePolicyTool.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { handleManagePolicy } from "./managePolicyTool.js";

const mockTools = [
  { name: "readFile", description: "Read a file", safe: false },
  { name: "add", description: "Add two numbers", safe: true },
];

function makeContext(overrides: {
  policy?: any;
  onSetPolicy?: (p: any) => void;
} = {}) {
  let currentPolicy = overrides.policy ?? {};
  return {
    tools: mockTools,
    getPolicy: () => currentPolicy,
    setPolicy: (p: any) => {
      currentPolicy = p;
      overrides.onSetPolicy?.(p);
    },
  };
}

describe("handleManagePolicy", () => {
  describe("list_tools", () => {
    it("returns tool info", () => {
      const result = handleManagePolicy({ operation: "list_tools" }, makeContext());
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("readFile");
      expect(parsed[1].safe).toBe(true);
    });
  });

  describe("show_policy", () => {
    it("returns current policy", () => {
      const policy = { "std::read": [{ action: "approve" as const }] };
      const result = handleManagePolicy({ operation: "show_policy" }, makeContext({ policy }));
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content[0].text)).toEqual(policy);
    });
  });

  describe("set_policy", () => {
    it("replaces and persists policy", () => {
      let persisted: any = null;
      const newPolicy = { "std::write": [{ action: "reject" as const }] };
      const ctx = makeContext({ onSetPolicy: (p) => { persisted = p; } });
      const result = handleManagePolicy({ operation: "set_policy", policy: newPolicy }, ctx);
      expect(result.isError).toBe(false);
      expect(persisted).toEqual(newPolicy);
      expect(ctx.getPolicy()).toEqual(newPolicy);
    });

    it("rejects invalid policy", () => {
      const result = handleManagePolicy(
        { operation: "set_policy", policy: { "std::read": "not an array" } },
        makeContext(),
      );
      expect(result.isError).toBe(true);
    });

    it("resets to empty with empty object", () => {
      let persisted: any = null;
      const ctx = makeContext({
        policy: { "std::read": [{ action: "approve" as const }] },
        onSetPolicy: (p) => { persisted = p; },
      });
      handleManagePolicy({ operation: "set_policy", policy: {} }, ctx);
      expect(persisted).toEqual({});
      expect(ctx.getPolicy()).toEqual({});
    });
  });

  it("returns error for unknown operation", () => {
    const result = handleManagePolicy({ operation: "unknown" }, makeContext());
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run lib/mcp/managePolicyTool.test.ts 2>&1 > /tmp/claude/task6-fail.txt && cat /tmp/claude/task6-fail.txt`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement handleManagePolicy**

Create `lib/mcp/managePolicyTool.ts`:

```typescript
import { validatePolicy, type Policy } from "../runtime/policy.js";
import type { McpToolResult } from "./types.js";

type ToolInfo = {
  name: string;
  description: string;
  safe: boolean;
};

export type ManagePolicyContext = {
  tools: ToolInfo[];
  getPolicy: () => Policy;
  setPolicy: (policy: Policy) => void;
};

function ok(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

function fail(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function handleManagePolicy(
  args: { operation: string; policy?: unknown },
  context: ManagePolicyContext,
): McpToolResult {
  switch (args.operation) {
    case "list_tools":
      return ok(context.tools.map((t) => ({
        name: t.name,
        description: t.description,
        safe: t.safe,
      })));

    case "show_policy":
      return ok(context.getPolicy());

    case "set_policy": {
      const validation = validatePolicy(args.policy);
      if (!validation.success) {
        return fail(`Invalid policy: ${validation.error}`);
      }
      context.setPolicy(args.policy as Policy);
      return ok({ status: "saved", policy: args.policy });
    }

    default:
      return fail(`Unknown operation: ${args.operation}. Valid operations: list_tools, show_policy, set_policy`);
  }
}

export const MANAGE_POLICY_TOOL_DEFINITION = {
  name: "manage_policy",
  description:
    "Configure which operations this MCP server is allowed to perform. " +
    "Use list_tools to see available tools, show_policy to see current permissions, " +
    "and set_policy to update permissions. Policies control which interrupt-gated " +
    "actions (file reads, writes, deletes, etc.) are approved or rejected.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list_tools", "show_policy", "set_policy"],
        description: "The operation to perform",
      },
      policy: {
        type: "object",
        description: "The full policy object (only for set_policy). Keys are interrupt kinds, values are arrays of rules.",
      },
    },
    required: ["operation"],
    additionalProperties: false,
  },
};
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/mcp/managePolicyTool.test.ts 2>&1 > /tmp/claude/task6-pass.txt && cat /tmp/claude/task6-pass.txt`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```
git add lib/mcp/managePolicyTool.ts lib/mcp/managePolicyTool.test.ts
git commit -m "Add manage_policy tool with list_tools, show_policy, set_policy"
```

---

## Task 7: Implement agencyServer.ts

**Files:**
- Create: `lib/mcp/agencyServer.ts`
- Create: `lib/mcp/agencyServer.test.ts`
- Reference: `lib/mcp/server.ts` (for JSON-RPC helpers)
- Reference: `lib/mcp/formatResult.ts`
- Reference: `lib/mcp/policyHandler.ts`
- Reference: `lib/mcp/managePolicyTool.ts`
- Reference: `lib/runtime/agencyFunction.ts`

This is the thin composition layer (<100 lines of logic).

- [ ] **Step 1: Research Zod-to-JSON-Schema conversion**

Check which version of Zod the project uses and what JSON Schema conversion is available:

Run: `grep '"zod"' package.json` and `grep -r "jsonSchema\|toJsonSchema\|zod-to-json-schema" lib/ --include="*.ts" | head -10`

Determine whether to use `zodToJsonSchema()` from `zod-to-json-schema` package, Zod v4's built-in `z.toJsonSchema()`, or another approach. The tool definition schemas in `AgencyFunction.toolDefinition.schema` are Zod runtime objects that need to be converted to JSON Schema for MCP's `inputSchema` field.

- [ ] **Step 2: Research RuntimeContext interrupt handler wiring**

Read these files to understand how interrupt handlers work at runtime:
- `lib/runtime/node.ts` — look for `pushHandler`, `__ctx.handlers`
- `lib/runtime/interrupts.ts` — look for how handlers receive and respond to interrupts
- Any existing handler test in `tests/agency/`

The goal is to understand how to wire `handleInterruptWithPolicy` into the handler chain when invoking a tool. Document the approach for the implementation.

- [ ] **Step 3: Write tests**

Create `lib/mcp/agencyServer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createAgencyMcpHandler, discoverExportedTools } from "./agencyServer.js";
import { AgencyFunction } from "../runtime/agencyFunction.js";

function makeTestFunction(name: string, opts?: { exported?: boolean; safe?: boolean }): AgencyFunction {
  const registry: Record<string, AgencyFunction> = {};
  return AgencyFunction.create(
    {
      name,
      module: "test",
      fn: async () => `${name} result`,
      params: [],
      toolDefinition: { name, description: `Test ${name}`, schema: null },
      exported: opts?.exported ?? false,
      safe: opts?.safe ?? false,
    },
    registry,
  );
}

describe("discoverExportedTools", () => {
  it("returns only exported functions", () => {
    const registry: Record<string, AgencyFunction> = {};
    AgencyFunction.create({ name: "internal", module: "t", fn: async () => {}, params: [], toolDefinition: null, exported: false }, registry);
    AgencyFunction.create({ name: "public", module: "t", fn: async () => {}, params: [], toolDefinition: { name: "public", description: "d", schema: null }, exported: true }, registry);
    const tools = discoverExportedTools(registry);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("public");
  });

  it("returns empty array when no exported functions", () => {
    const registry: Record<string, AgencyFunction> = {};
    AgencyFunction.create({ name: "internal", module: "t", fn: async () => {}, params: [], toolDefinition: null }, registry);
    expect(discoverExportedTools(registry)).toEqual([]);
  });
});

describe("createAgencyMcpHandler", () => {
  it("responds to initialize", async () => {
    const handler = createAgencyMcpHandler({ tools: [], policy: {}, serverName: "test", onPolicyChange: () => {} });
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } },
    });
    expect(response?.result?.protocolVersion).toBe("2025-06-18");
    expect(response?.result?.capabilities?.tools).toBeDefined();
  });

  it("lists tools including manage_policy", async () => {
    const fn = makeTestFunction("myTool", { exported: true });
    const handler = createAgencyMcpHandler({ tools: [fn], policy: {}, serverName: "test" });
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = response?.result?.tools.map((t: any) => t.name);
    expect(names).toContain("myTool");
    expect(names).toContain("manage_policy");
  });

  it("calls a tool and returns formatted result", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const fn = AgencyFunction.create({
      name: "greet",
      module: "test",
      fn: async () => "hello world",
      params: [],
      toolDefinition: { name: "greet", description: "Greets", schema: null },
      exported: true,
    }, registry);
    const handler = createAgencyMcpHandler({ tools: [fn], policy: {}, serverName: "test" });
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "greet", arguments: {} },
    });
    expect(response?.result?.content[0].text).toBe(JSON.stringify("hello world"));
    expect(response?.result?.isError).toBe(false);
  });

  it("returns error for unknown tool", async () => {
    const handler = createAgencyMcpHandler({ tools: [], policy: {}, serverName: "test" });
    const response = await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nonexistent", arguments: {} },
    });
    expect(response?.error).toBeDefined();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test:run lib/mcp/agencyServer.test.ts 2>&1 > /tmp/claude/task7-fail.txt && cat /tmp/claude/task7-fail.txt`

Expected: FAIL — module not found.

- [ ] **Step 5: Implement agencyServer.ts**

Create `lib/mcp/agencyServer.ts`. Key implementation notes:
- Use the Zod-to-JSON-Schema approach determined in Step 1
- For `invoke()`, the test functions above don't need a `state` parameter because they are plain async functions. But compiled Agency functions DO need `state` passed as the last argument (it carries `{ ctx: RuntimeContext }`). The `serve.ts` CLI command (Task 8) is responsible for creating the RuntimeContext and passing it. For now, `agencyServer.ts` passes `undefined` as state, which works for the test functions.
- Wire `handleInterruptWithPolicy` using the approach determined in Step 2, or document that it will be wired in Task 8.

```typescript
import { AgencyFunction } from "../runtime/agencyFunction.js";
import { success, error, type JsonRpcMessage } from "./server.js";
import { formatMcpResult } from "./formatResult.js";
import { handleManagePolicy, MANAGE_POLICY_TOOL_DEFINITION, type ManagePolicyContext } from "./managePolicyTool.js";
import { VERSION } from "../version.js";
import type { Policy } from "../runtime/policy.js";
import type { McpToolResult } from "./types.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";

type ServerConfig = {
  tools: AgencyFunction[];
  policy: Policy;
  serverName: string;
  onPolicyChange?: (policy: Policy) => void;
};

export function discoverExportedTools(
  registry: Record<string, AgencyFunction>,
): AgencyFunction[] {
  return Object.values(registry).filter((fn) => fn.exported && fn.toolDefinition);
}

function toolToMcpDefinition(fn: AgencyFunction): Record<string, unknown> {
  // Zod-to-JSON-Schema conversion: use approach determined in Step 1
  let inputSchema: Record<string, unknown> = { type: "object", properties: {} };
  if (fn.toolDefinition?.schema) {
    try {
      // TODO: Use the correct Zod-to-JSON-Schema approach from Step 1
      inputSchema = (fn.toolDefinition.schema as any).jsonSchema?.()
        ?? { type: "object", properties: {} };
    } catch {
      // Fallback on conversion error
    }
  }

  const def: Record<string, unknown> = {
    name: fn.name,
    description: fn.toolDefinition?.description ?? "No description",
    inputSchema,
  };
  if (fn.safe) {
    def.annotations = { readOnlyHint: true };
  }
  return def;
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  toolMap: Map<string, AgencyFunction>,
  managePolicyContext: ManagePolicyContext,
): Promise<McpToolResult> {
  if (name === "manage_policy") {
    return handleManagePolicy(args as any, managePolicyContext);
  }

  const fn = toolMap.get(name);
  if (!fn) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  try {
    const result = await fn.invoke({ type: "named", positionalArgs: [], namedArgs: args });
    return formatMcpResult(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

export function createAgencyMcpHandler(config: ServerConfig) {
  const { tools, serverName, onPolicyChange = () => {} } = config;
  let policy = config.policy;
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const managePolicyContext: ManagePolicyContext = {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.toolDefinition?.description ?? "",
      safe: t.safe,
    })),
    getPolicy: () => policy,
    setPolicy: (p) => { policy = p; onPolicyChange(p); },
  };

  return async (message: JsonRpcMessage): Promise<JsonRpcMessage | null> => {
    if (message.jsonrpc !== "2.0") {
      return error(message.id ?? null, -32600, "Expected JSON-RPC 2.0 message");
    }

    switch (message.method) {
      case "initialize":
        return success(message.id ?? null, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: VERSION },
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return success(message.id ?? null, {});
      case "tools/list": {
        const mcpTools = tools.map(toolToMcpDefinition);
        mcpTools.push(MANAGE_POLICY_TOOL_DEFINITION);
        return success(message.id ?? null, { tools: mcpTools });
      }
      case "tools/call":
        return success(
          message.id ?? null,
          await handleToolCall(message.params?.name, message.params?.arguments ?? {}, toolMap, managePolicyContext),
        );
      case "shutdown":
        return success(message.id ?? null, {});
      case "exit":
        process.exit(0);
      default:
        if (message.id !== undefined) {
          return error(message.id, -32601, `Method not found: ${message.method}`);
        }
        return null;
    }
  };
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm test:run lib/mcp/agencyServer.test.ts 2>&1 > /tmp/claude/task7-pass.txt && cat /tmp/claude/task7-pass.txt`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```
git add lib/mcp/agencyServer.ts lib/mcp/agencyServer.test.ts
git commit -m "Add agencyServer composition layer for MCP tool serving"
```

---

## Task 8: Implement the `agency serve` CLI command

**Files:**
- Create: `lib/cli/serve.ts`
- Modify: `scripts/agency.ts`
- Reference: `lib/cli/commands.ts` (for `compile` function — lines 100-242)
- Reference: `lib/cli/util.ts` (for shared CLI utilities)

This task wires everything together: compile the Agency file, discover exports, load policy, start the server.

- [ ] **Step 1: Study the existing CLI compilation and run patterns**

Read these to understand how existing commands compile and execute Agency files:
- `lib/cli/commands.ts` — the `compile()` function (lines 100-242) and the `run()` function (lines 276-296)
- `scripts/agency.ts` — how the `run` command invokes `run()` from commands.ts
- `lib/cli/util.ts` — shared utilities

The `compile()` function in `commands.ts` takes `(config, inputFile, outputFile?, options?)` and returns the output file path as a string, or null. The `run()` function calls `compile()` with a `RunStrategy` import strategy, then spawns the compiled file as a subprocess.

For the `serve` command, we need to compile (like `run`) but then dynamically import the compiled module in-process (not as a subprocess) so we can access the `__toolRegistry`.

- [ ] **Step 2: Implement serve.ts**

Create `lib/cli/serve.ts`:

```typescript
import fs from "fs";
import path from "path";
import os from "os";
import { compile } from "./commands.js";
import { loadConfig } from "./commands.js";
import { RunStrategy } from "../backends/importStrategies.js";
import { discoverExportedTools, createAgencyMcpHandler } from "../mcp/agencyServer.js";
import { resolvePolicy } from "../mcp/policyHandler.js";
import { startStdioServer } from "../mcp/server.js";

type ServeOptions = {
  name?: string;
  policy?: string;
  node?: string;
};

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function persistPolicy(serverName: string, policy: unknown): void {
  const dir = path.join(os.homedir(), ".agency", "mcp", "servers", serverName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify(policy, null, 2), { mode: 0o600 });
}

export async function serveCommand(file: string, options: ServeOptions): Promise<void> {
  const serverName = options.name ?? path.basename(file, path.extname(file));
  const config = loadConfig();

  // 1. Compile the Agency file
  const outputFile = compile(config, file, undefined, {
    importStrategy: new RunStrategy(),
  });
  if (!outputFile) {
    console.error("Error: Compilation failed.");
    process.exit(1);
  }

  // 2. Dynamically import the compiled module to access the tool registry
  const absoluteOutput = path.resolve(outputFile);
  const mod = await import(absoluteOutput);
  const registry = mod.__toolRegistry ?? {};
  const tools = discoverExportedTools(registry);

  if (tools.length === 0) {
    console.error(`No exported functions found in ${file}. Use 'export def' to export functions as MCP tools.`);
    process.exit(1);
  }

  // 3. Load policy
  const agencyDir = path.dirname(path.resolve(file));
  const defaultPolicyPath = path.join(agencyDir, "policy.json");
  const policy = resolvePolicy({
    cliPolicyPath: options.policy,
    serverName,
    defaultPolicyPath: fs.existsSync(defaultPolicyPath) ? defaultPolicyPath : undefined,
    readFile: readFileOrNull,
  });

  // 4. Create handler and start server
  const handler = createAgencyMcpHandler({
    tools,
    policy,
    serverName,
    onPolicyChange: (p) => persistPolicy(serverName, p),
  });

  startStdioServer(handler);
}
```

Note: `loadConfig` and `RunStrategy` imports may need adjustment based on actual export paths — check these during implementation. Also, `__toolRegistry` may not be directly accessible on the module; check how the compiled output exports it. If it is not exported, the implementer may need to find how the existing `run` command accesses the registry, or add an explicit export to the compiled output.

- [ ] **Step 3: Add the serve command to scripts/agency.ts**

In `scripts/agency.ts`, add the `serve` command before the `default` command (before line 623):

```typescript
program
  .command("serve")
  .description("Start an MCP server exposing exported Agency functions as tools")
  .argument("<file>", "Agency file to serve")
  .option("--name <name>", "Server name (defaults to filename)")
  .option("--policy <path>", "Path to policy JSON file")
  .option("--node <name>", "Node to run for initialization before serving")
  .action(async (file: string, options: any) => {
    const { serveCommand } = await import("../lib/cli/serve.js");
    await serveCommand(file, options);
  });
```

- [ ] **Step 4: Verify the command registers**

Run: `pnpm run agency serve --help 2>&1 > /tmp/claude/task8-help.txt && cat /tmp/claude/task8-help.txt`

Expected: Help output showing the serve command with its options.

- [ ] **Step 5: Commit**

```
git add lib/cli/serve.ts scripts/agency.ts
git commit -m "Add agency serve CLI command for MCP server mode"
```

---

## Task 9: End-to-end test with a real Agency file

**Files:**
- Create: `tests/agency/mcp-server-basic.agency`
- Create or modify: `lib/mcp/agencyServer.test.ts`

- [ ] **Step 1: Create a test Agency file**

Create `tests/agency/mcp-server-basic.agency`:

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

- [ ] **Step 2: Compile and verify exports**

Run: `pnpm run compile tests/agency/mcp-server-basic.agency 2>&1 > /tmp/claude/task9-compile.txt && cat /tmp/claude/task9-compile.txt`

Expected: Compiles successfully.

- [ ] **Step 3: Manual smoke test**

Test the full flow:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test"}}}' | pnpm run agency serve tests/agency/mcp-server-basic.agency 2>/dev/null
```

Expected: JSON-RPC response with server info. If this fails, debug by checking stderr output (remove `2>/dev/null`).

- [ ] **Step 4: Test tools/list**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n' | pnpm run agency serve tests/agency/mcp-server-basic.agency 2>/dev/null
```

Expected: Response listing `add`, `greet`, and `manage_policy` tools. `internal` should NOT appear.

- [ ] **Step 5: Test tools/call**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add","arguments":{"a":3,"b":4}}}\n' | pnpm run agency serve tests/agency/mcp-server-basic.agency 2>/dev/null
```

Expected: Response with result `7`.

- [ ] **Step 6: Commit**

```
git add tests/agency/mcp-server-basic.agency
git commit -m "Add end-to-end test fixture for MCP server"
```

---

## Task 10: Documentation

**Files:**
- Modify: `docs-new/guide/mcp.md`

- [ ] **Step 1: Add "Creating MCP Servers" section to the MCP guide**

Add a new section to `docs-new/guide/mcp.md` after the existing content. Cover:
- The `agency serve` command and its options
- How `export` controls which functions are exposed
- How PFAs work as constrained tools (note: requires `export const` support)
- Policy files and the `manage_policy` tool
- Example showing the full flow

- [ ] **Step 2: Review the docs for accuracy**

Read through the section and verify all commands, syntax, and file paths are correct.

- [ ] **Step 3: Commit**

```
git add docs-new/guide/mcp.md
git commit -m "Add documentation for creating MCP servers with Agency"
```
