# Audit Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audit logging that emits structured entries via an `onAudit` callback for every operation an agent performs — assignments, function calls, returns, LLM calls, tool calls, node entry/exit, and interrupts.

**Architecture:** Callback-only (no storage). The builder injects `__ctx.audit(...)` calls after statements in `processBodyAsParts`. The runtime adds manual audit calls at key points (LLM calls, tool calls, node entry/exit, interrupts). An optional config/CLI flag enables JSONL file logging via a generated default `onAudit` callback.

**Tech Stack:** TypeScript, TypeScript IR (`lib/ir/`), Agency runtime (`lib/runtime/`), Agency builder (`lib/backends/typescriptBuilder.ts`)

**Spec:** `docs/superpowers/specs/2026-03-20-audit-logs-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `lib/runtime/audit.ts` | `AuditEntry` discriminated union type definition |
| `lib/ir/audit.ts` | `auditNode(node: TsNode): TsNode \| null` — inspects IR nodes and produces audit call IR |
| `lib/ir/audit.test.ts` | Unit tests for `auditNode` |

### Modified files

| File | Change |
|------|--------|
| `lib/runtime/hooks.ts` | Add `onAudit: AuditEntry` to `CallbackMap` |
| `lib/runtime/state/context.ts` | Import `callHook`, add `audit()` method to `RuntimeContext` |
| `lib/runtime/index.ts` | Re-export `AuditEntry` type |
| `lib/runtime/node.ts` | Add 2 `audit()` calls (nodeEntry, nodeExit) |
| `lib/runtime/prompt.ts` | Add 2 `audit()` calls (llmCall, toolCall) |
| `lib/runtime/interrupts.ts` | Add 1 `audit()` call (interrupt) |
| `lib/backends/typescriptBuilder.ts` | Import `auditNode`, add 3 lines in `processBodyAsParts`, add audit log file code generation in `generateImports` and `generateExportedNodeFunctions` |
| `lib/config.ts` | Add `audit?: { logFile?: string }` to `AgencyConfig` |
| `scripts/agency.ts` | Add `-l, --log <file>` option to `run` command |

---

## Task 1: AuditEntry type and callback integration

**Files:**
- Create: `lib/runtime/audit.ts`
- Modify: `lib/runtime/hooks.ts:13-49` (add `onAudit` to `CallbackMap`)
- Modify: `lib/runtime/state/context.ts:1-7,86-91` (add import and `audit()` method)
- Modify: `lib/runtime/index.ts:1-2` (add re-export)

- [ ] **Step 1: Create `lib/runtime/audit.ts`**

```ts
import type { TokenUsage } from "smoltalk";

type AuditBase = { timestamp: number };

export type AssignmentAudit = AuditBase & {
  type: "assignment";
  variable: string;
  value: unknown;
};

export type FunctionCallAudit = AuditBase & {
  type: "functionCall";
  functionName: string;
  args: unknown;
  result: unknown;
};

export type ReturnAudit = AuditBase & {
  type: "return";
  value: unknown;
};

export type LLMCallAudit = AuditBase & {
  type: "llmCall";
  model: string;
  prompt: string;
  response: unknown;
  tokens: TokenUsage | undefined;
  duration: number;
};

export type ToolCallAudit = AuditBase & {
  type: "toolCall";
  functionName: string;
  args: unknown;
  result: unknown;
  duration: number;
};

export type NodeEntryAudit = AuditBase & {
  type: "nodeEntry";
  nodeName: string;
};

export type NodeExitAudit = AuditBase & {
  type: "nodeExit";
  nodeName: string;
};

export type InterruptAudit = AuditBase & {
  type: "interrupt";
  nodeName: string;
  args: unknown;
};

export type AuditEntry =
  | AssignmentAudit
  | FunctionCallAudit
  | ReturnAudit
  | LLMCallAudit
  | ToolCallAudit
  | NodeEntryAudit
  | NodeExitAudit
  | InterruptAudit;
```

- [ ] **Step 2: Add `onAudit` to `CallbackMap` in `lib/runtime/hooks.ts`**

Add import at the top:

```ts
import type { AuditEntry } from "./audit.js";
```

Add to `CallbackMap` (after the `onStream` entry, before the closing `}`):

```ts
  onAudit: AuditEntry;
```

- [ ] **Step 3: Add `audit()` method to `RuntimeContext` in `lib/runtime/state/context.ts`**

Change the import on line 7 from:

```ts
import type { AgencyCallbacks } from "../hooks.js";
```

to:

```ts
import { callHook } from "../hooks.js";
import type { AgencyCallbacks } from "../hooks.js";
```

Add import for AuditEntry:

```ts
import type { AuditEntry } from "../audit.js";
```

Add this method to the `RuntimeContext` class, after the `getSmoltalkConfig` method (after line 109):

```ts
  async audit(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    const fullEntry = { ...entry, timestamp: Date.now() };
    await callHook({ callbacks: this.callbacks, name: "onAudit", data: fullEntry as AuditEntry });
  }
```

- [ ] **Step 4: Re-export `AuditEntry` from `lib/runtime/index.ts`**

Add after line 2 (`export type { Interrupt, InterruptResponse } from "./interrupts.js";`):

```ts
export type { AuditEntry } from "./audit.js";
```

- [ ] **Step 5: Build and verify**

Run: `make all`
Expected: No build errors.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/audit.ts lib/runtime/hooks.ts lib/runtime/state/context.ts lib/runtime/index.ts
git commit -m "feat(audit): add AuditEntry type, onAudit callback, and ctx.audit() method"
```

---

## Task 2: Runtime instrumentation

**Files:**
- Modify: `lib/runtime/node.ts:104-126` (add nodeEntry/nodeExit audit calls)
- Modify: `lib/runtime/prompt.ts:126-142` (add llmCall audit call)
- Modify: `lib/runtime/prompt.ts:304-313` (add toolCall audit call)
- Modify: `lib/runtime/interrupts.ts:92-94` (add interrupt audit call)

- [ ] **Step 1: Add nodeEntry/nodeExit audit calls in `lib/runtime/node.ts`**

In the `runNode` function, after the `onAgentStart` callHook (after line 108):

```ts
  await execCtx.audit({ type: "nodeEntry", nodeName });
```

Before `createReturnObject` (before line 117):

```ts
    await execCtx.audit({ type: "nodeExit", nodeName });
```

- [ ] **Step 2: Add llmCall audit in `lib/runtime/prompt.ts`**

In `_runPrompt`, after `updateTokenStats` (after line 130), before the `onLLMCallEnd` callHook (before line 131):

```ts
  await ctx.audit({
    type: "llmCall",
    model: String(modelName),
    prompt,
    response: completion.output,
    tokens: completion.usage,
    duration: endTime - startTime,
  });
```

- [ ] **Step 3: Add toolCall audit in `lib/runtime/prompt.ts`**

In `executeToolCalls`, capture the original args before the `__state` push. Before line 248 (`params.push({`), add:

```ts
      const auditArgs = [...params];
```

Then after the `onToolCallEnd` callHook (after line 313):

```ts
      await ctx.audit({
        type: "toolCall",
        functionName: handler.name,
        args: auditArgs,
        result,
        duration: toolCallEndTime - toolCallStartTime,
      });
```

- [ ] **Step 4: Add interrupt audit in `lib/runtime/interrupts.ts`**

In `respondToInterrupt`, after `nodeName` is defined (after line 109, `const nodeName = nodesTraversed[nodesTraversed.length - 1];`):

```ts
  await execCtx.audit({ type: "interrupt", nodeName, args: interruptResponse });
```

- [ ] **Step 5: Build and verify**

Run: `make all`
Expected: No build errors.

- [ ] **Step 6: Run existing tests**

Run: `pnpm test:run`
Expected: All existing tests pass. The audit calls are no-ops when no `onAudit` callback is registered.

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/node.ts lib/runtime/prompt.ts lib/runtime/interrupts.ts
git commit -m "feat(audit): add runtime audit calls for node, LLM, tool, and interrupt events"
```

---

## Task 3: `auditNode` IR helper

**Files:**
- Create: `lib/ir/audit.ts`
- Create: `lib/ir/audit.test.ts`

- [ ] **Step 1: Write unit tests in `lib/ir/audit.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ts, $ } from "./builders.js";
import { printTs } from "./prettyPrint.js";
import { auditNode } from "./audit.js";

describe("auditNode", () => {
  it("returns audit call for assign", () => {
    const node = ts.assign(ts.self("x"), ts.num(5));
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!);
    expect(code).toContain('__ctx.audit');
    expect(code).toContain('"assignment"');
    expect(code).toContain('"__self.x"');
    expect(code).toContain('__self.x');
  });

  it("returns audit call for varDecl", () => {
    const node = ts.constDecl("myVar", ts.num(42));
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!);
    expect(code).toContain('"assignment"');
    expect(code).toContain('"myVar"');
  });

  it("returns audit call for call", () => {
    const node = ts.call(ts.id("myFunc"), [ts.str("arg1")]);
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!);
    expect(code).toContain('"functionCall"');
    expect(code).toContain('"myFunc"');
  });

  it("returns audit call for return", () => {
    const node = ts.return(ts.num(42));
    const result = auditNode(node);
    expect(result).not.toBeNull();
    // Return audit should be a statements node: [auditCall, originalReturn]
    expect(result!.kind).toBe("statements");
  });

  it("returns audit call for functionReturn", () => {
    const node: any = { kind: "functionReturn", value: ts.num(42) };
    const result = auditNode(node);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("statements");
  });

  it("unwraps await and inspects inner", () => {
    const node = ts.await(ts.call(ts.id("fetchData"), []));
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!);
    expect(code).toContain('"functionCall"');
    expect(code).toContain('"fetchData"');
  });

  it("returns null for comment", () => {
    const node = ts.comment("this is a comment");
    expect(auditNode(node)).toBeNull();
  });

  it("returns null for if", () => {
    const node = ts.if(ts.bool(true), ts.statements([]));
    expect(auditNode(node)).toBeNull();
  });

  it("returns null for empty", () => {
    const node: any = { kind: "empty" };
    expect(auditNode(node)).toBeNull();
  });

  it("emits per-variable audits for array destructuring assignment (Promise.all pattern)", () => {
    // Simulates: [__self.x, __self.y] = await Promise.all([__self.x, __self.y])
    const node = ts.assign(
      ts.arr([ts.self("x"), ts.self("y")]),
      ts.await(ts.call(ts.prop(ts.id("Promise"), "all"), [ts.arr([ts.self("x"), ts.self("y")])])),
    );
    const result = auditNode(node);
    expect(result).not.toBeNull();
    // Should be a statements node with two audit calls
    expect(result!.kind).toBe("statements");
    const code = printTs(result!);
    expect(code).toContain('"__self.x"');
    expect(code).toContain('"__self.y"');
  });

  it("handles statements by auditing first meaningful child", () => {
    const node = ts.statements([
      ts.comment("ignore me"),
      ts.assign(ts.self("y"), ts.str("hello")),
    ]);
    const result = auditNode(node);
    expect(result).not.toBeNull();
    const code = printTs(result!);
    expect(code).toContain('"assignment"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/ir/audit.test.ts`
Expected: FAIL — `auditNode` does not exist yet.

- [ ] **Step 3: Create `lib/ir/audit.ts`**

```ts
import { $, ts } from "./builders.js";
import type { TsNode } from "./tsIR.js";
import { printTs } from "./prettyPrint.js";

/**
 * Inspects a processed TsNode and returns a TsNode that represents
 * an `await __ctx.audit(...)` call, or null if this node should not be audited.
 *
 * For return/functionReturn nodes, returns a TsStatements containing
 * [auditCall, originalNode] since the audit must run before the return.
 */
export function auditNode(node: TsNode): TsNode | null {
  switch (node.kind) {
    case "assign":
      // For destructuring assignments like [x, y] = await Promise.all([x, y]),
      // emit one assignment audit per variable
      if (node.lhs.kind === "arrayLiteral") {
        const audits = node.lhs.items
          .map((item) => makeAuditCall("assignment", {
            variable: ts.str(printTs(item)),
            value: item,
          }));
        return audits.length === 1 ? audits[0] : ts.statements(audits);
      }
      return makeAuditCall("assignment", {
        variable: ts.str(printTs(node.lhs)),
        value: node.lhs,
      });

    case "varDecl":
      return makeAuditCall("assignment", {
        variable: ts.str(node.name),
        value: ts.id(node.name),
      });

    case "call":
      return makeAuditCall("functionCall", {
        functionName: ts.str(printTs(node.callee)),
        args: ts.arr(node.arguments),
      });

    case "return":
      if (node.expr) {
        const audit = makeAuditCall("return", { value: node.expr });
        return ts.statements([audit, node]);
      }
      return ts.statements([makeAuditCall("return", { value: ts.id("undefined") }), node]);

    case "functionReturn":
      const audit = makeAuditCall("return", { value: node.value });
      return ts.statements([audit, node]);

    case "await":
      return auditNode(node.expr);

    case "statements":
      for (const child of node.body) {
        const result = auditNode(child);
        if (result) return result;
      }
      return null;

    default:
      return null;
  }
}

function makeAuditCall(type: string, fields: Record<string, TsNode>): TsNode {
  return $(ts.runtime.ctx)
    .prop("audit")
    .call([ts.obj({ type: ts.str(type), ...fields })])
    .await()
    .done();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- lib/ir/audit.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Build**

Run: `make all`
Expected: No build errors.

- [ ] **Step 6: Commit**

```bash
git add lib/ir/audit.ts lib/ir/audit.test.ts
git commit -m "feat(audit): add auditNode IR helper with unit tests"
```

---

## Task 4: Builder injection in `processBodyAsParts`

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1813-1830` (import `auditNode`, inject in `processBodyAsParts`)

- [ ] **Step 1: Import `auditNode` at the top of `lib/backends/typescriptBuilder.ts`**

Add near the other IR imports:

```ts
import { auditNode } from "../ir/audit.js";
```

- [ ] **Step 2: Modify `processBodyAsParts` to inject audit calls**

In `processBodyAsParts`, change lines 1827-1828 from:

```ts
      parts[parts.length - 1].push(this.processStatement(stmt));
    }
```

to:

```ts
      const processed = this.processStatement(stmt);
      const audit = auditNode(processed);
      if (audit && audit.kind === "statements" && (processed.kind === "return" || processed.kind === "functionReturn")) {
        // For returns, auditNode returns [auditCall, originalReturn] — replace the original
        parts[parts.length - 1].push(audit);
      } else {
        parts[parts.length - 1].push(processed);
        if (audit) {
          parts[parts.length - 1].push(audit);
        }
      }
    }
```

- [ ] **Step 3: Build**

Run: `make all`
Expected: No build errors.

- [ ] **Step 4: Run all tests**

Run: `pnpm test:run`
Expected: Some generator fixture tests may fail because the generated output now includes audit calls. This is expected — we will regenerate fixtures.

- [ ] **Step 5: Regenerate fixtures**

Run: `make fixtures`

- [ ] **Step 6: Inspect a fixture to verify audit calls appear**

Read the generated `.mjs` file for `tests/typescriptGenerator/assignment.mjs` and verify that `__ctx.audit(...)` calls appear after assignment statements.

- [ ] **Step 7: Run all tests again**

Run: `pnpm test:run`
Expected: All tests PASS with the regenerated fixtures.

- [ ] **Step 8: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/ tests/typescriptBuilder/
git commit -m "feat(audit): inject audit calls in processBodyAsParts"
```

---

## Task 5: CLI audit log file

**Files:**
- Modify: `lib/config.ts:150-151` (add `audit` config)
- Modify: `scripts/agency.ts:62-70` (add `-l` flag to `run` command)
- Modify: `lib/cli/commands.ts:227-264` (pass log file to compile/run)
- Modify: `lib/backends/typescriptBuilder.ts:1838-1884` (generate audit log file code in `generateImports`)
- Modify: `lib/backends/typescriptBuilder.ts:1954-1982` (merge default `onAudit` in exported node functions)

- [ ] **Step 1: Add `audit` config to `AgencyConfig` in `lib/config.ts`**

Before the closing `}` of `AgencyConfig` (before line 151):

```ts
  /** Audit logging config */
  audit?: {
    logFile?: string;
  };
```

- [ ] **Step 2: Add `-l, --log` option to `run` command in `scripts/agency.ts`**

Change lines 62-70 from:

```ts
program
  .command("run")
  .description("Compile and run .agency file(s)")
  .argument("[input]", "Paths to .agency input file")
  .option("--resume <statefile>", "Resume execution from a saved state file")
  .action((input: string, options: { resume?: string }) => {
    const config = getConfig();
    run(config, input, undefined, options.resume);
  });
```

to:

```ts
program
  .command("run")
  .description("Compile and run .agency file(s)")
  .argument("[input]", "Paths to .agency input file")
  .option("--resume <statefile>", "Resume execution from a saved state file")
  .option("-l, --log <file>", "Write audit log entries to a JSONL file")
  .action((input: string, options: { resume?: string; log?: string }) => {
    const config = getConfig();
    if (options.log) {
      config.audit = { ...config.audit, logFile: options.log };
    }
    run(config, input, undefined, options.resume);
  });
```

- [ ] **Step 3: Add audit log file code generation in `generateImports` in `lib/backends/typescriptBuilder.ts`**

The `generateImports` method returns the output of `renderImports.default({ runtimeContextCode })`. The template (`lib/templates/backends/typescriptGenerator/imports.mustache`) inserts `runtimeContextCode` via `{{{runtimeContextCode:string}}}` at line 70.

The simplest approach: append the audit log setup code to the `runtimeCtx` statements before passing to the template. In `generateImports`, after the `runtimeCtx` declaration (line ~1867-1879) and before the `return renderImports.default(...)` call (line 1881), add:

```ts
    if (this.agencyConfig.audit?.logFile) {
      const logFile = this.agencyConfig.audit.logFile;
      runtimeCtx = ts.statements([
        runtimeCtx,
        ts.raw(`import { appendFileSync } from "fs";`),
        ts.raw(`const __auditLogFile = ${JSON.stringify(logFile)};`),
        ts.raw(`const __defaultOnAudit = (entry) => { appendFileSync(__auditLogFile, JSON.stringify(entry) + "\\n"); };`),
      ]);
    }
```

Note: `runtimeCtx` needs to be declared with `let` instead of `const` (change line ~1867).

- [ ] **Step 4: Conditionally merge default `onAudit` in exported node functions**

In `generateExportedNodeFunctions`, change the `callbacks` property in the `runNode` call (line 1975) based on whether `audit.logFile` is configured:

```ts
callbacks: this.agencyConfig.audit?.logFile
  ? ts.raw("{ onAudit: __defaultOnAudit, ...callbacks }")
  : ts.id("callbacks"),
```

When `audit.logFile` is set, the generated code spreads user-provided callbacks over the default, so a user-provided `onAudit` overrides the file logger. When `audit.logFile` is not set, the callbacks are passed through unchanged.

- [ ] **Step 5: Build and verify**

Run: `make all`
Expected: No build errors.

- [ ] **Step 6: Manual test**

Create a test `.agency` file and compile with `audit.logFile` set in a local `agency.json`. Verify the generated JS contains the `__defaultOnAudit` function and the callbacks merging.

- [ ] **Step 7: Regenerate fixtures**

Run: `make fixtures`
Expected: Fixtures should not change since `audit.logFile` is not set in the default config used for fixture generation.

- [ ] **Step 8: Run all tests**

Run: `pnpm test:run`
Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/config.ts scripts/agency.ts lib/cli/commands.ts lib/backends/typescriptBuilder.ts
git commit -m "feat(audit): add CLI -l flag and audit.logFile config for JSONL file logging"
```

---

## Task 6: Integration test fixtures

**Files:**
- Create: `tests/typescriptGenerator/audit.agency`

- [ ] **Step 1: Create the fixture Agency file**

Create `tests/typescriptGenerator/audit.agency`:

```
def greet(name: string): string {
  return "Hello, ${name}!"
}

node main() {
  x = 5
  greeting = greet("world")
  print(greeting)
}
```

This exercises assignments, function calls with return values, and return statements — the key audit cases.

- [ ] **Step 2: Generate the fixture**

Run: `make fixtures`

- [ ] **Step 3: Inspect the generated fixture**

Read `tests/typescriptGenerator/audit.mjs` and verify:
- `__ctx.audit(...)` calls appear after the `x = 5` assignment
- `__ctx.audit(...)` calls appear after the `greeting = greet(...)` call
- `__ctx.audit(...)` calls appear before the `return` in `greet`
- The audit calls contain the correct types: `"assignment"`, `"functionCall"`, `"return"`

- [ ] **Step 4: Run all tests**

Run: `pnpm test:run`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/typescriptGenerator/audit.agency tests/typescriptGenerator/audit.mjs
git commit -m "test(audit): add integration test fixture for audit log code generation"
```

---

## Task 7: End-to-end test with `onAudit` callback verification

**Files:**
- Create: `tests/agency-ts/audit/agent.agency`
- Create: `tests/agency-ts/audit/test.js`
- Create: `tests/agency-ts/audit/fixture.json`

This test uses the `agency-ts` test format (see `docs/TESTING.md` section 5) to verify that audit entries actually fire at runtime with the correct data. The `test.js` file imports the compiled agent, passes an `onAudit` callback, collects entries, and writes the result.

- [ ] **Step 1: Create `tests/agency-ts/audit/agent.agency`**

```
def double(n: number): number {
  return n * 2
}

node main(x: number): number {
  result = double(x)
  return result
}
```

- [ ] **Step 2: Create `tests/agency-ts/audit/test.js`**

```js
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const entries = [];
const result = await main(5, {
  callbacks: {
    onAudit: (entry) => {
      // Strip timestamps for deterministic comparison
      const { timestamp, ...rest } = entry;
      entries.push(rest);
    }
  }
});

writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data, auditTypes: entries.map(e => e.type) }, null, 2),
);
```

- [ ] **Step 3: Create `tests/agency-ts/audit/fixture.json`**

Run the test first to see what the actual output is, then create the fixture from that output. The expected `auditTypes` array should include entries like `["nodeEntry", "assignment", ...]` — the exact sequence depends on the generated audit calls plus the runtime calls.

Run: `pnpm run agency test --js tests/agency-ts/audit`

Inspect `tests/agency-ts/audit/__result.json`, verify the `data` is `10` and `auditTypes` contains the expected sequence (nodeEntry, assignment, functionCall, return, nodeExit at minimum). Copy the result to `fixture.json`.

- [ ] **Step 4: Run the test again to verify it passes**

Run: `pnpm run agency test --js tests/agency-ts/audit`
Expected: Test PASSES — fixture matches.

- [ ] **Step 5: Commit**

```bash
git add tests/agency-ts/audit/
git commit -m "test(audit): add end-to-end test verifying onAudit callback entries"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full build**

Run: `make all`
Expected: Clean build, no errors.

- [ ] **Step 2: Full test suite**

Run: `pnpm test:run`
Expected: All unit and integration tests pass.

- [ ] **Step 3: Run agency-ts tests**

Run: `pnpm run agency test --js tests/agency-ts/audit`
Expected: End-to-end audit test passes.

- [ ] **Step 4: Verify no regressions in agency tests**

Run: `pnpm run agency test tests/agency`
Expected: All existing agency execution tests pass. Audit calls are no-ops when no callback is registered.
