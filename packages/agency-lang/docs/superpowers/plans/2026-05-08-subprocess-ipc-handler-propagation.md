# Subprocess IPC + Handler Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Agency agents compile and execute Agency code in a subprocess, with the parent's handler chain extending across the process boundary via Node IPC.

**Architecture:** Two new stdlib files (`stdlib/agency.agency` + `stdlib/lib/agency.ts`) expose `compile()` and `run()`. The compilation pipeline from `lib/cli/commands.ts` is extracted into a reusable function. The runtime's `interruptWithHandlers` gets an IPC-mode code path (activated by `AGENCY_IPC=1` env var) that sends interrupts to the parent process instead of returning them. A subprocess bootstrap script handles fresh and resume startup modes.

**Tech Stack:** Node.js `child_process.fork()` for IPC, existing Agency compilation pipeline, existing runtime interrupt infrastructure.

**Spec:** `docs/superpowers/specs/2026-05-07-subprocess-ipc-handler-propagation-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/compiler/compile.ts` | **Create.** Pure compilation pipeline extracted from `lib/cli/commands.ts`. No `process.exit`, no `console.log`. Takes source string + config, returns compiled JS string or errors. |
| `lib/cli/commands.ts` | **Modify.** Refactor `compile()` to call into `lib/compiler/compile.ts`. |
| `lib/runtime/ipc.ts` | **Create.** IPC-mode interrupt handling. Sends interrupts to the parent over IPC and awaits decisions. |
| `lib/runtime/subprocess-bootstrap.ts` | **Create.** Entry point for subprocess execution. Handles fresh mode (run a node) and resume mode (restore from checkpoint + apply interrupt response). Communicates with parent via IPC. |
| `stdlib/agency.agency` | **Create.** Agency-side API: `compile()` and `run()` functions with interrupt gates. |
| `stdlib/lib/agency.ts` | **Create.** TypeScript backing: `_compile()` runs the pipeline, `_run()` forks subprocess and manages IPC protocol. |
| `lib/runtime/interrupts.ts` | **Modify.** Add IPC mode check — when `AGENCY_IPC=1`, delegate to `ipc.ts` instead of normal flow. |
| `tests/agency/subprocess/` | **Create.** Execution tests for compile + run. |

---

### Task 1: Extract the compilation pipeline into a pure function

The current `compile()` in `lib/cli/commands.ts` calls `process.exit()` and `console.log()`. We need a version that returns errors instead.

**Files:**
- Create: `lib/compiler/compile.ts`
- Create: `lib/compiler/compile.test.ts`
- Modify: `lib/cli/commands.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/compiler/compile.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { compileSource } from "./compile.js";

describe("compileSource", () => {
  it("compiles valid Agency source to JavaScript", () => {
    const source = `node main() { return "hello" }`;
    const result = compileSource(source, {});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.code).toContain("function");
      expect(result.moduleId).toBeTruthy();
    }
  });

  it("returns errors for invalid syntax", () => {
    const source = `node main( { return "hello" }`;
    const result = compileSource(source, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("returns errors for type check failures when typeCheck is enabled", () => {
    const source = `
def foo(x: number): string { return x }
node main() { return foo(42) }
`;
    const result = compileSource(source, { typeCheck: true });
    expect(result.success).toBe(false);
  });

  it("rejects local relative imports", () => {
    const source = `
import { foo } from "./bar.agency"
node main() { return foo() }
`;
    const result = compileSource(source, { restrictImports: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]).toContain("import");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/compiler/compile.test.ts 2>&1 | tee /tmp/test-compile-1.txt`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `compileSource`**

Create `lib/compiler/compile.ts`. This extracts the core logic from `lib/cli/commands.ts:100-242` into a pure function that:
- Takes a source string + `AgencyConfig` (no file path needed for the source — we generate a synthetic module ID)
- Parses, builds symbol table, resolves imports, type-checks, generates TypeScript, transpiles to JS
- Returns `{ success: true, code: string, moduleId: string }` or `{ success: false, errors: string[] }`
- Never calls `process.exit()` or `console.log()`
- Uses `config.restrictImports = true` to reject local relative imports (only `std::` and npm imports allowed)

Key implementation details:
- Use `nanoid()` for the synthetic module ID
- Use the existing `parse()`, `SymbolTable.build()`, `buildCompilationUnit()`, `generateTypeScript()` pipeline
- For the symbol table, since there's no real file, use a temp-file-like path: `path.join(os.tmpdir(), moduleId + ".agency")`
- Use `transformSync` from esbuild to transpile TS → JS (same as current `compile()`)
- Wrap the entire pipeline in try/catch to convert thrown errors into the error result

Reference the existing `compile()` at `lib/cli/commands.ts:100-242` for the pipeline steps.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run -- lib/compiler/compile.test.ts 2>&1 | tee /tmp/test-compile-2.txt`
Expected: PASS

- [ ] **Step 5: Refactor CLI compile to use the new function**

Modify `lib/cli/commands.ts`: refactor the existing `compile()` function to delegate to `compileSource()` for the core pipeline, keeping the CLI-specific behavior (file I/O, `process.exit()`, `console.log()`) in the CLI layer.

- [ ] **Step 6: Run existing tests to verify no regression**

Run: `pnpm test:run 2>&1 | tee /tmp/test-regression-1.txt`
Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```
git add lib/compiler/
git commit -m "extract compilation pipeline into reusable compileSource function"
```

---

### Task 2: Create the stdlib `compile()` function

**Files:**
- Create: `stdlib/agency.agency`
- Create: `stdlib/lib/agency.ts`
- Create: `tests/agency/subprocess/compile-success.agency`
- Create: `tests/agency/subprocess/compile-success.test.json`
- Create: `tests/agency/subprocess/compile-failure.agency`
- Create: `tests/agency/subprocess/compile-failure.test.json`

- [ ] **Step 1: Write the Agency test for successful compilation**

Create `tests/agency/subprocess/compile-success.agency`:

```
import { compile } from "std::agency"

node main() {
  const source = "node main() { return 42 }"
  const result = compile(source)
  if (isSuccess(result)) {
    return "compiled"
  }
  return "failed"
}
```

Create `tests/agency/subprocess/compile-success.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "compile() returns success for valid Agency source",
      "input": "",
      "expectedOutput": "\"compiled\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Write the Agency test for compilation failure**

Create `tests/agency/subprocess/compile-failure.agency`:

```
import { compile } from "std::agency"

node main() {
  const source = "node main( { return 42 }"
  const result = compile(source)
  if (isFailure(result)) {
    return "correctly failed"
  }
  return "unexpected success"
}
```

Create `tests/agency/subprocess/compile-failure.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "compile() returns failure for invalid Agency source",
      "input": "",
      "expectedOutput": "\"correctly failed\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm run agency test tests/agency/subprocess/compile-success.agency 2>&1 | tee /tmp/test-stdlib-compile-1.txt`
Expected: FAIL — `std::agency` module doesn't exist yet.

- [ ] **Step 4: Create `stdlib/lib/agency.ts`**

```typescript
import { compileSource } from "../../lib/compiler/compile.js";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { nanoid } from "nanoid";

export function _compile(source: string): { moduleId: string; path: string } {
  const result = compileSource(source, {
    typeCheck: true,
    restrictImports: true,
  });

  if (!result.success) {
    throw new Error(result.errors.join("\n"));
  }

  // Write compiled JS to temp file
  const moduleId = `agency_${nanoid()}`;
  const tempDir = mkdtempSync(join(tmpdir(), "agency-"));
  const tempPath = join(tempDir, `${moduleId}.js`);
  writeFileSync(tempPath, result.code, "utf-8");

  return { moduleId, path: tempPath };
}
```

- [ ] **Step 5: Create `stdlib/agency.agency`**

```
import { _compile } from "./lib/agency.js"

// The Agency-visible type omits `path` intentionally — it's an implementation
// detail. The runtime JS object returned by _compile() has both `moduleId`
// and `path`. Agency's structural typing means _run() can access `path`
// from the JS object even though the Agency type doesn't declare it.
type CompiledProgram = {
  moduleId: string
}

export def compile(source: string): Result {
  """
  Compile Agency source code. Returns a CompiledProgram on success, or a failure with compilation errors.
  @param source - Agency source code as a string
  """
  return try _compile(source)
}
```

- [ ] **Step 6: Register the stdlib module**

The stdlib modules are discovered by the import resolver. Check `lib/imports/stdlibResolver.ts` (or equivalent) to see if new stdlib modules are auto-discovered or need manual registration. Add `agency` to the stdlib registry if needed.

Also run `make` to rebuild everything (critical when changing stdlib files, per CLAUDE.md).

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm run agency test tests/agency/subprocess/compile-success.agency 2>&1 | tee /tmp/test-stdlib-compile-2.txt`
Run: `pnpm run agency test tests/agency/subprocess/compile-failure.agency 2>&1 | tee /tmp/test-stdlib-compile-3.txt`
Expected: Both PASS.

- [ ] **Step 8: Commit**

```
git add stdlib/agency.agency stdlib/lib/agency.ts tests/agency/subprocess/
git commit -m "add std::agency compile() function"
```

---

### Task 3: Create the subprocess bootstrap script

This is the entry point that Node forks. It receives startup instructions over IPC and either runs a node from scratch or resumes from a checkpoint.

**Files:**
- Create: `lib/runtime/subprocess-bootstrap.ts`
- Create: `lib/runtime/subprocess-bootstrap.test.ts`

- [ ] **Step 1: Write a unit test for the bootstrap**

Create `lib/runtime/subprocess-bootstrap.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { fork } from "child_process";
import path from "path";
import { compileSource } from "../compiler/compile.js";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("subprocess-bootstrap", () => {
  it("runs a node and returns the result over IPC", async () => {
    // Compile a simple program
    const result = compileSource(`node main() { return 42 }`, {});
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Write to temp file
    const tempDir = mkdtempSync(join(tmpdir(), "agency-test-"));
    const tempPath = join(tempDir, "test.js");
    writeFileSync(tempPath, result.code, "utf-8");

    // Fork the bootstrap
    const bootstrapPath = path.resolve("dist/lib/runtime/subprocess-bootstrap.js");
    const child = fork(bootstrapPath, [], {
      stdio: ["pipe", "inherit", "inherit", "ipc"],
      env: { ...process.env, AGENCY_IPC: "1" },
    });

    // Send run instruction
    child.send({ mode: "run", scriptPath: tempPath, node: "main", args: {} });

    // Wait for result
    const msg: any = await new Promise((resolve) => {
      child.on("message", resolve);
    });

    expect(msg.type).toBe("done");
    expect(msg.value.success).toBe(true);
    expect(msg.value.value.data).toBe(42);

    // Cleanup
    rmSync(tempDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/runtime/subprocess-bootstrap.test.ts 2>&1 | tee /tmp/test-bootstrap-1.txt`
Expected: FAIL — bootstrap doesn't exist.

- [ ] **Step 3: Implement the bootstrap**

Create `lib/runtime/subprocess-bootstrap.ts`:

The bootstrap script:
1. Listens for a startup message from the parent via `process.on('message')`
2. On `{ mode: "run" }`: dynamically imports the compiled script, finds the node function, calls `runNode()`, sends the result back via `process.send()`
3. On `{ mode: "resume" }`: builds a `RuntimeContext`, restores from the provided checkpoint, applies interrupt responses, re-runs
4. Wraps everything in try/catch — any uncaught error sends `{ type: "done", value: { success: false, error: error.message } }`
5. Exits after sending the result

Key references:
- `lib/runtime/node.ts:runNode()` — how nodes are executed
- `lib/runtime/interrupts.ts:respondToInterrupts()` — how checkpoints are restored and interrupt responses applied
- The compiled JS file exports a `__globalCtx` (the `RuntimeContext`) and node functions. Check existing compiled output fixtures (e.g., `tests/typescriptGenerator/simple.mjs`) to see the export shape.

Note: For MVP, only implement `mode: "run"`. `mode: "resume"` is needed for the slow-path (serialize + resume) which can be added in a follow-up task.

- [ ] **Step 4: Build and run test**

Run: `make && pnpm test:run -- lib/runtime/subprocess-bootstrap.test.ts 2>&1 | tee /tmp/test-bootstrap-2.txt`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add lib/runtime/subprocess-bootstrap.ts lib/runtime/subprocess-bootstrap.test.ts
git commit -m "add subprocess bootstrap entry point for IPC mode"
```

---

### Task 4: IPC-mode interrupt handling

When `AGENCY_IPC=1` is set, `interruptWithHandlers` should send interrupts to the parent over IPC instead of returning `Interrupt[]`.

**Files:**
- Create: `lib/runtime/ipc.ts`
- Modify: `lib/runtime/interrupts.ts`

- [ ] **Step 1: Create `lib/runtime/ipc.ts`**

This module provides:

```typescript
// Returns true if we're running in IPC mode (subprocess)
export function isIpcMode(): boolean {
  return process.env.AGENCY_IPC === "1";
}

// Send an interrupt to the parent and await the decision.
// Returns the parent's decision: approve or reject.
export async function sendInterruptToParent(interrupt: {
  kind: string;
  message: string;
  data: any;
  origin: string;
}, propagated: boolean): Promise<{ type: "approve"; value?: any } | { type: "reject"; value?: any }> {
  return new Promise((resolve) => {
    const handler = (msg: any) => {
      if (msg.type === "decision") {
        process.removeListener("message", handler);
        if (msg.approved) {
          resolve({ type: "approve", value: msg.value });
        } else {
          resolve({ type: "reject", value: msg.value });
        }
      }
      if (msg.type === "serialize") {
        // Slow path — parent wants us to serialize and exit.
        // For MVP, just reject (serialize/resume is a follow-up).
        process.removeListener("message", handler);
        resolve({ type: "reject", value: "subprocess serialization not yet supported" });
      }
    };
    process.on("message", handler);
    process.send!({
      type: "interrupt",
      interrupt: { kind: interrupt.kind, message: interrupt.message, data: interrupt.data, origin: interrupt.origin },
      propagated,
    });
  });
}

```

- [ ] **Step 2: Modify `interruptWithHandlers` for IPC mode**

In `lib/runtime/interrupts.ts`, modify `interruptWithHandlers` to check for IPC mode. When in IPC mode:

1. Run local handlers as normal (subprocess handlers are innermost)
2. If local handler rejects → short-circuit, don't consult parent
3. Otherwise → call `sendInterruptToParent()` with the interrupt data and whether any local handler propagated
4. Return the parent's decision (approve or reject)

The modification has two insertion points:

**First**, at the top of the function, before the `ctx.handlers.length === 0` early return (line 135). In IPC mode, even zero local handlers should consult the parent:

```typescript
import { isIpcMode, sendInterruptToParent } from "./ipc.js";

// At the very top of interruptWithHandlers:
if (isIpcMode() && ctx.handlers.length === 0) {
  // No local handlers, but in IPC mode we must consult parent
  const parentDecision = await sendInterruptToParent(
    { kind, message, data, origin },
    false, // no local propagation
  );
  if (parentDecision.type === "approve") {
    return { type: "approve", value: parentDecision.value };
  }
  return { type: "reject", value: parentDecision.value };
}
```

**Second**, after the local handler loop finishes (after line 180), before the normal-mode returns:

```typescript
if (isIpcMode()) {
  // In IPC mode, always consult parent (unless local handler rejected — that already returned above)
  const parentDecision = await sendInterruptToParent(
    { kind, message, data, origin },
    hasPropagation,
  );
  if (parentDecision.type === "approve") {
    return { type: "approve", value: parentDecision.value ?? approvedValue };
  }
  return { type: "reject", value: parentDecision.value };
}

// Normal mode (existing behavior)
if (hasPropagation) {
  return [interrupt({ kind, message, data, origin, runId: ctx.getRunId() })];
}
// ... rest of existing code
```

This ensures IPC mode consults the parent in ALL cases: zero handlers, approved handlers, propagated handlers — the only exception is when a local handler rejects (which already returned at line 159).

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `pnpm test:run 2>&1 | tee /tmp/test-regression-ipc-1.txt`
Expected: All existing tests still pass (IPC mode is only active when env var is set).

- [ ] **Step 4: Commit**

```
git add lib/runtime/ipc.ts lib/runtime/interrupts.ts
git commit -m "add IPC-mode interrupt handling for subprocess execution"
```

---

### Task 5: Implement `_run()` — the parent-side IPC manager

This is the core of the feature: the TypeScript function that forks a subprocess, manages the IPC protocol, and returns the result.

**Files:**
- Modify: `stdlib/lib/agency.ts`
- Create: `tests/agency/subprocess/run-basic.agency`
- Create: `tests/agency/subprocess/run-basic.test.json`

- [ ] **Step 1: Write the Agency execution test**

Create `tests/agency/subprocess/run-basic.agency`:

```
import { compile, run } from "std::agency"

node main() {
  const source = "node main() { return 42 }"
  const compiled = compile(source)
  if (isFailure(compiled)) {
    return "compile failed"
  }

  handle {
    const result = run(compiled, { node: "main", args: {} })
    if (isSuccess(result)) {
      return result.value.data
    }
    return "run failed"
  } with (data) {
    return approve()
  }
}
```

Create `tests/agency/subprocess/run-basic.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "compile() then run() executes subprocess and returns result",
      "input": "",
      "expectedOutput": "42",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run agency test tests/agency/subprocess/run-basic.agency 2>&1 | tee /tmp/test-run-1.txt`
Expected: FAIL — `run` not yet implemented.

- [ ] **Step 3: Implement `_run()` in `stdlib/lib/agency.ts`**

Add `_run()` to `stdlib/lib/agency.ts`. This function:

1. Takes `compiled: { path: string, moduleId: string }` and `options: { node: string, args: object }`
2. Forks the subprocess bootstrap script: `fork(bootstrapPath, [], { stdio: ['pipe', 'inherit', 'inherit', 'ipc'], env: { ...process.env, AGENCY_IPC: '1' } })`
3. Sends `{ mode: "run", scriptPath: compiled.path, node: options.node, args: options.args }` to the child
4. Listens for IPC messages from the child:
   - `{ type: "interrupt", ... }`: calls `interruptWithHandlers()` on the parent's `ctx` (passed as a parameter from the Agency function). If handlers resolve → send `{ type: "decision", approved, value }`. If handlers don't resolve (propagate) → for MVP, send `{ type: "decision", approved: false, value: "propagated to user" }`. (Full slow-path with serialize is a follow-up.)
   - `{ type: "done", value }`: resolve the promise with the value (value is a Result — `{ success: true, value: RunNodeResult }` or `{ success: false, error: string }`)
5. Listens for child `close`/`exit` event: if child exits without sending `done`, return a failure
6. Cleans up the temp file on completion
7. Returns the `RunNodeResult`

Key challenge: `_run()` needs access to the parent's `ctx` (for `interruptWithHandlers`). The stdlib backing function receives this as a parameter from the generated code. Check how existing stdlib backing functions access runtime context — look at how `_bash` in `stdlib/lib/shell.ts` gets invoked from the generated code, and whether `ctx` is available.

If `ctx` is not directly available to stdlib backing functions, we may need to pass it through. Check `lib/templates/backends/typescriptGenerator/` for how stdlib function calls are generated.

- [ ] **Step 4: Add `run()` to `stdlib/agency.agency`**

Update `stdlib/agency.agency` to add the `run()` function (as shown in the spec). The `run()` function triggers an interrupt (`std::run` kind) before calling `_run()`.

- [ ] **Step 5: Build and run test**

Run: `make && pnpm run agency test tests/agency/subprocess/run-basic.agency 2>&1 | tee /tmp/test-run-2.txt`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add stdlib/agency.agency stdlib/lib/agency.ts tests/agency/subprocess/
git commit -m "implement run() with subprocess IPC execution"
```

---

### Task 6: Handler propagation across process boundary

Test that the parent's handlers apply to subprocess interrupts.

**Files:**
- Create: `tests/agency/subprocess/handler-reject.agency`
- Create: `tests/agency/subprocess/handler-reject.test.json`
- Create: `tests/agency/subprocess/handler-approve.agency`
- Create: `tests/agency/subprocess/handler-approve.test.json`

- [ ] **Step 1: Write test for parent handler rejecting subprocess interrupt**

Create `tests/agency/subprocess/handler-reject.agency`:

```
import { compile, run } from "std::agency"

node main() {
  const source = "import { bash } from \"std::shell\"\nnode main() {\n  handle {\n    bash(\"echo hi\")\n  } with (data) {\n    return approve()\n  }\n  return \"done\"\n}"
  const compiled = compile(source)
  if (isFailure(compiled)) {
    return "compile failed: " + compiled.error
  }

  handle {
    const result = run(compiled, { node: "main", args: {} })
    if (isSuccess(result)) {
      return "subprocess succeeded unexpectedly"
    }
    return "parent rejected"
  } with (data) {
    if (data.kind == "std::run") {
      return approve()
    }
    // Reject all other interrupts (including bash from subprocess)
    return reject()
  }
}
```

Create `tests/agency/subprocess/handler-reject.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Parent handler rejects subprocess interrupt even when subprocess handler approves",
      "input": "",
      "expectedOutput": "\"parent rejected\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Write test for parent handler approving subprocess interrupt**

Create `tests/agency/subprocess/handler-approve.agency`:

```
import { compile, run } from "std::agency"

node main() {
  const source = "import { bash } from \"std::shell\"\nnode main() {\n  handle {\n    let result = bash(\"echo hello\")\n    return result.stdout\n  } with (data) {\n    return approve()\n  }\n}"
  const compiled = compile(source)
  if (isFailure(compiled)) {
    return "compile failed: " + compiled.error
  }

  handle {
    const result = run(compiled, { node: "main", args: {} })
    if (isSuccess(result)) {
      return result.value.data
    }
    return "failed: " + result.error
  } with (data) {
    return approve()
  }
}
```

Create `tests/agency/subprocess/handler-approve.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Parent handler approves subprocess interrupt, subprocess proceeds",
      "input": "",
      "expectedOutput": "\"hello\\n\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Run tests**

Run: `make && pnpm run agency test tests/agency/subprocess/handler-reject.agency 2>&1 | tee /tmp/test-handler-1.txt`
Run: `pnpm run agency test tests/agency/subprocess/handler-approve.agency 2>&1 | tee /tmp/test-handler-2.txt`
Expected: Both PASS.

- [ ] **Step 4: Commit**

```
git add tests/agency/subprocess/
git commit -m "add handler propagation tests for subprocess execution"
```

---

### Task 7: Run existing .agency files as subprocesses

Extension beyond the original spec: `run()` also accepts a file path string. When given a file path, `run()` compiles and executes the file as a subprocess. Unlike `compile()` for generated code, file-path compilation does NOT set `restrictImports` — existing files on disk should be able to use local imports normally.

**Files:**
- Modify: `stdlib/agency.agency`
- Modify: `stdlib/lib/agency.ts`
- Create: `tests/agency/subprocess/run-file.agency`
- Create: `tests/agency/subprocess/run-file.test.json`
- Create: `tests/agency/subprocess/helper-agent.agency`

- [ ] **Step 1: Write the test**

Create `tests/agency/subprocess/helper-agent.agency`:

```
node main(greeting: string) {
  return "Hello from subprocess: " + greeting
}
```

Create `tests/agency/subprocess/run-file.agency`:

```
import { run } from "std::agency"

node main() {
  handle {
    const result = run("./helper-agent.agency", { node: "main", args: { greeting: "world" } })
    if (isSuccess(result)) {
      return result.value.data
    }
    return "failed"
  } with (data) {
    return approve()
  }
}
```

Create `tests/agency/subprocess/run-file.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "run() accepts a file path and executes the .agency file as a subprocess",
      "input": "",
      "expectedOutput": "\"Hello from subprocess: world\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Update `run()` to accept string | CompiledProgram**

Modify `stdlib/agency.agency`: update the `run` function signature to accept `source: CompiledProgram | string`.

Modify `stdlib/lib/agency.ts`: in `_run()`, check if the first argument is a string. If so, compile it first using `compileSource()`, then proceed as normal. When compiling from a file path, DON'T use `restrictImports` — existing files should be able to use local imports.

- [ ] **Step 3: Build and run test**

Run: `make && pnpm run agency test tests/agency/subprocess/run-file.agency 2>&1 | tee /tmp/test-runfile-1.txt`
Expected: PASS

- [ ] **Step 4: Commit**

```
git add stdlib/agency.agency stdlib/lib/agency.ts tests/agency/subprocess/
git commit -m "support running existing .agency files as subprocesses"
```

---

### Task 8: Cleanup, timeout, and error handling

**Files:**
- Modify: `stdlib/lib/agency.ts`
- Create: `tests/agency/subprocess/run-crash.agency`
- Create: `tests/agency/subprocess/run-crash.test.json`

- [ ] **Step 1: Write test for subprocess crash**

Create a helper file `tests/agency/subprocess/crash-helper.js`:

```javascript
export function crashNow() {
  throw new Error("boom");
}
```

Create `tests/agency/subprocess/run-crash.agency`:

```
import { compile, run } from "std::agency"

node main() {
  const source = "import { crashNow } from \"./crash-helper.js\"\nnode main() {\n  crashNow()\n  return \"unreachable\"\n}"
  const compiled = compile(source)
  if (isFailure(compiled)) {
    return "compile failed"
  }

  handle {
    const result = run(compiled, { node: "main", args: {} })
    if (isFailure(result)) {
      return "caught error"
    }
    return "unexpected success"
  } with (data) {
    return approve()
  }
}
```

Note: The generated code imports a JS file that throws. Since `compile()` restricts local imports for generated code, this test may need to use a file-path `run()` instead, or the crash helper needs to be accessible another way. An alternative approach: compile a program that does `let x = 1 / 0` or accesses a property on null — anything that produces a runtime error without using `throw`. The implementer should choose whichever approach works with the import restrictions.

Create `tests/agency/subprocess/run-crash.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "run() returns failure when subprocess throws an error",
      "input": "",
      "expectedOutput": "\"caught error\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Ensure `_run()` handles edge cases**

In `stdlib/lib/agency.ts`, verify that `_run()`:
- Deletes the temp file on success or failure (use a `finally` block)
- Handles subprocess exit without IPC message (listen for `close` event)
- Kills the subprocess if the parent's `AbortSignal` fires
- Optionally supports a `timeout` parameter in the options

- [ ] **Step 3: Run test**

Run: `make && pnpm run agency test tests/agency/subprocess/run-crash.agency 2>&1 | tee /tmp/test-crash-1.txt`
Expected: PASS

- [ ] **Step 4: Run the full subprocess test suite**

Run: `pnpm run agency test tests/agency/subprocess/ 2>&1 | tee /tmp/test-all-subprocess.txt`
Expected: All subprocess tests PASS.

- [ ] **Step 5: Run the full test suite for regressions**

Run: `pnpm test:run 2>&1 | tee /tmp/test-regression-final.txt`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```
git add stdlib/lib/agency.ts tests/agency/subprocess/
git commit -m "add error handling, cleanup, and crash recovery for subprocess execution"
```

---

### Task 9: Block nested subprocess execution

**Files:**
- Modify: `stdlib/lib/agency.ts`
- Create: `tests/agency/subprocess/nested-blocked.agency`
- Create: `tests/agency/subprocess/nested-blocked.test.json`

- [ ] **Step 1: Write test**

Create `tests/agency/subprocess/nested-blocked.agency`:

```
import { compile, run } from "std::agency"

node main() {
  const source = "import { compile, run } from \"std::agency\"\nnode main() {\n  const c = compile(\"node main() { return 1 }\")\n  return run(c, { node: \"main\", args: {} })\n}"
  const compiled = compile(source)
  if (isFailure(compiled)) {
    return "compile failed"
  }

  handle {
    const result = run(compiled, { node: "main", args: {} })
    if (isFailure(result)) {
      return "nested blocked"
    }
    return "unexpected success"
  } with (data) {
    return approve()
  }
}
```

Create `tests/agency/subprocess/nested-blocked.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Nested subprocess execution is blocked in MVP",
      "input": "",
      "expectedOutput": "\"nested blocked\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Implement the nesting guard**

In `stdlib/lib/agency.ts`, in `_run()`: check if `process.env.AGENCY_IPC === '1'`. If so, throw an error: "Nested subprocess execution is not supported."

- [ ] **Step 3: Run test**

Run: `make && pnpm run agency test tests/agency/subprocess/nested-blocked.agency 2>&1 | tee /tmp/test-nested-1.txt`
Expected: PASS

- [ ] **Step 4: Commit**

```
git add stdlib/lib/agency.ts tests/agency/subprocess/
git commit -m "block nested subprocess execution in MVP"
```

---

## Notes for the implementer

### Key files to read first
- `docs/superpowers/specs/2026-05-07-subprocess-ipc-handler-propagation-design.md` — the full spec
- `lib/cli/commands.ts:100-300` — current compile and run pipeline
- `lib/runtime/interrupts.ts:126-181` — `interruptWithHandlers` function
- `lib/runtime/node.ts:81-210` — `runNode` function
- `stdlib/shell.agency` + `stdlib/lib/shell.ts` — stdlib pattern to follow
- `docs/dev/interrupts.md` — how interrupts work
- `docs/TESTING.md` — testing guide

### Critical invariants
- **Handlers are safety infrastructure.** Never skip them. The subprocess's interrupts MUST go through the parent's handler chain.
- **`AGENCY_IPC=1` is the only signal for IPC mode.** Don't use any other mechanism.
- **Always clean up temp files.** Use `finally` blocks.
- **Always rebuild with `make` after changing stdlib files.** The stdlib is compiled as part of the build process.

### What's explicitly out of scope for this plan
- Subprocess checkpoint serialization + resume (the "slow path"). MVP sends reject when parent can't resolve.
- Debugger/trace integration with subprocesses.
- Nested subprocess execution (blocked with clear error).
- `input()` proxying (can be added as a follow-up within the IPC framework).
- Timeout parameter on `run()`.
