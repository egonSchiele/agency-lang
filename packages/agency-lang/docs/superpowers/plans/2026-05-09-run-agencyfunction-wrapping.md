# `_run` AgencyFunction Wrapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `_run()` receive `RuntimeContext` via the same `AgencyFunction` wrapping pattern used by `checkpoint`, `getCheckpoint`, and `restore`, unblocking subprocess IPC handler propagation.

**Architecture:** Move `_run` from `lib/stdlib/agency.ts` to `lib/runtime/ipc.ts`, export it from `agency-lang/runtime`, and add the `AgencyFunction.create` wrapping in the imports template. The compiled output of every module will include the wrapping (same as checkpoint), but it's dead code in modules that don't use it.

**Tech Stack:** Existing AgencyFunction wrapping infrastructure, mustache templates, runtime exports.

**Spec:** `docs/superpowers/specs/2026-05-09-run-receives-ctx-via-agencyfunction-wrapping.md`

**Note:** As of PR #116, all stdlib backing TS files moved from `stdlib/lib/` to `lib/stdlib/`. They now compile alongside `lib/` via a single `tsc` pass, and `.agency` files import them via `"agency-lang/stdlib-lib/*"`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/runtime/ipc.ts` | **Modify.** Add `_run` function (moved from `lib/stdlib/agency.ts`). Signature changes: last param becomes `__state: InternalFunctionState`, runtime guard removed. |
| `lib/runtime/index.ts` | **Modify.** Add `_run` to the runtime exports. |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | **Modify.** Add `_run` import alias and `AgencyFunction.create` wrapping (line 12 and after line 68). |
| `lib/stdlib/agency.ts` | **Modify.** Remove `_run` (it moves to `lib/runtime/ipc.ts`). Keep `_compile`. |
| `stdlib/agency.agency` | **Modify.** Remove `_run` from the import line. `_run` is now available as a module-level constant from the imports template. |

---

### Task 1: Move `_run` to `lib/runtime/ipc.ts` and update its signature

**Files:**
- Modify: `lib/runtime/ipc.ts`
- Modify: `lib/stdlib/agency.ts`

- [ ] **Step 1: Add `_run` to `lib/runtime/ipc.ts`**

Copy the `_run` function from `lib/stdlib/agency.ts` to `lib/runtime/ipc.ts`. Change the signature:
- Replace the ad-hoc `state?: { ctx: any; threads: any; stateStack: any }` with `__state: InternalFunctionState` (non-optional)
- Remove the `if (!state?.ctx) throw` guard (no longer needed — `AgencyFunction.invoke()` always provides state)
- Update internal references from `state.ctx` to `__state.ctx` and `state.stateStack` to `__state.stateStack ?? __state.ctx.stateStack`. The fallback to `ctx.stateStack` matches the pattern in `checkpoint.ts:11` and handles the case where `_run` is called without a per-thread stack (e.g., outside of a fork/race branch). The original code used `state.stateStack` directly without a fallback.

Add these imports to the existing imports in `ipc.ts` (note: `subprocessBootstrapPath` is already defined in `ipc.ts`):

```typescript
import type { InternalFunctionState } from "./types.js";
import { interruptWithHandlers, isApproved, hasInterrupts } from "./interrupts.js";
import { fork } from "child_process";
import { rmSync } from "fs";
import { dirname } from "path";
import { tmpdir } from "os";
```

The function should look like this:

```typescript
export async function _run(
  compiled: { path: string; moduleId: string },
  options: { node: string; args: Record<string, any> },
  __state: InternalFunctionState,
): Promise<any> {
  const ctx = __state.ctx;
  const stateStack = __state.stateStack ?? ctx.stateStack;

  const child = fork(subprocessBootstrapPath, [], {
    stdio: ["pipe", "inherit", "inherit", "ipc"],
    env: { ...process.env, AGENCY_IPC: "1" },
  });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    const cleanup = () => {
      try {
        const tempDir = dirname(compiled.path);
        if (tempDir.startsWith(tmpdir())) {
          rmSync(tempDir, { recursive: true });
        }
      } catch (_) {
        // Ignore cleanup failures
      }
    };

    child.on("message", async (msg: any) => {
      if (msg.type === "interrupt") {
        const { kind, message, data, origin } = msg.interrupt;

        const handlerResult = await interruptWithHandlers(
          kind,
          message,
          data,
          origin,
          ctx,
          stateStack,
        );

        if (isApproved(handlerResult)) {
          child.send({
            type: "decision",
            approved: true,
            value: (handlerResult as any).value,
          });
        } else if (hasInterrupts(handlerResult)) {
          child.send({
            type: "decision",
            approved: false,
            value: "Interrupt propagated to user (subprocess slow-path not yet supported)",
          });
        } else {
          child.send({
            type: "decision",
            approved: false,
            value: (handlerResult as any).value,
          });
        }
      } else if (msg.type === "result") {
        if (!settled) {
          settled = true;
          cleanup();
          resolvePromise(msg.value);
        }
      } else if (msg.type === "error") {
        if (!settled) {
          settled = true;
          cleanup();
          rejectPromise(new Error(msg.error));
        }
      }
    });

    child.on("close", (code: number | null) => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectPromise(new Error(
          `Subprocess exited unexpectedly with code ${code}`,
        ));
      }
    });

    child.on("error", (err: Error) => {
      if (!settled) {
        settled = true;
        cleanup();
        rejectPromise(new Error(`Subprocess error: ${err.message}`));
      }
    });

    child.send({
      mode: "run",
      scriptPath: compiled.path,
      node: options.node,
      args: options.args,
    });
  });
}
```

Note: `interruptWithHandlers`, `isApproved`, and `hasInterrupts` are in the same compilation unit (`lib/runtime/`), so use relative imports.

- [ ] **Step 2: Remove `_run` from `lib/stdlib/agency.ts`**

Remove the entire `_run` function and its associated imports that are no longer needed (`interruptWithHandlers`, `isApproved`, `hasInterrupts`, `subprocessBootstrapPath`, `fork`, `dirname`, `rmSync`). Keep `_compile` and its imports (`compileSource`, `writeFileSync`, `mkdtempSync`, `join`, `tmpdir`).

After the change, `lib/stdlib/agency.ts` should contain only `_compile`:

```typescript
import { compileSource } from "../compiler/compile.js";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export function _compile(source: string): { moduleId: string; path: string } {
  const result = compileSource(source, {
    typeCheck: true,
    restrictImports: true,
  });

  if (!result.success) {
    throw new Error(result.errors.join("\n"));
  }

  const tempDir = mkdtempSync(join(tmpdir(), "agency-"));
  const tempPath = join(tempDir, `${result.moduleId}.js`);
  writeFileSync(tempPath, result.code, "utf-8");

  return { moduleId: result.moduleId, path: tempPath };
}
```

- [ ] **Step 3: Verify TypeScript compilation**

Run: `pnpm run build 2>&1 | tee /tmp/test-build-task1.txt`

Expected: Clean build. This catches type errors early before proceeding to the template changes.

- [ ] **Step 4: Commit**

```
git add lib/runtime/ipc.ts lib/stdlib/agency.ts
git commit -m "move _run from lib/stdlib to lib/runtime/ipc.ts, use InternalFunctionState"
```

---

### Task 2: Export `_run` from `agency-lang/runtime` and add imports template wrapping

**Files:**
- Modify: `lib/runtime/index.ts`
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache`

- [ ] **Step 1: Add `_run` to `lib/runtime/index.ts`**

Add this export alongside the existing IPC-related exports. Find a logical location (near the checkpoint exports or at the end):

```typescript
export { _run } from "./ipc.js";
```

- [ ] **Step 2: Add `_run` import alias in `imports.mustache`**

On line 12, add `_run as __run_impl` to the aliased imports. The line currently reads:

```
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl,
```

Change it to:

```
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl, _run as __run_impl,
```

- [ ] **Step 3: Add `AgencyFunction.create` wrapping for `_run` in `imports.mustache`**

After line 68 (the `restore` wrapping), add:

```typescript
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "options", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
```

- [ ] **Step 4: Recompile the template**

Run: `pnpm run templates`

This regenerates `lib/templates/backends/typescriptGenerator/imports.ts` from the mustache file.

- [ ] **Step 5: Commit**

```
git add lib/runtime/index.ts lib/templates/backends/typescriptGenerator/imports.mustache lib/templates/backends/typescriptGenerator/imports.ts
git commit -m "export _run from runtime and add AgencyFunction wrapping in imports template"
```

---

### Task 3: Update `stdlib/agency.agency` and rebuild

**Files:**
- Modify: `stdlib/agency.agency`

- [ ] **Step 1: Remove `_run` from the import in `stdlib/agency.agency`**

The current import line:

```
import { _compile, _run } from "agency-lang/stdlib-lib/agency.js"
```

Change to:

```
import { _compile } from "agency-lang/stdlib-lib/agency.js"
```

`_run` is now available as a module-level constant from the imports template (same as `checkpoint`, `getCheckpoint`, `restore`). The call site `return try _run(compiled, options)` in the `run` function continues to work unchanged.

- [ ] **Step 2: Rebuild everything**

Run: `make`

This recompiles the template, builds the TypeScript, compiles the stdlib `.agency` files, and rebuilds docs. All of these are needed since we changed the template and a stdlib file.

- [ ] **Step 3: Verify the compiled output**

Run: `grep "_run" stdlib/agency.js | head -10`

Expected: You should see `_run` being used in the compiled output (in the `__call(_run, ...)` calls), NOT see it imported from `agency-lang/stdlib-lib/agency.js`. The `_run` constant should come from the imports template preamble (same as `checkpoint`).

- [ ] **Step 4: Commit**

```
git add stdlib/agency.agency stdlib/agency.js
git commit -m "remove _run import from stdlib/agency.agency, now provided by imports template"
```

---

### Task 4: Run existing tests and verify no regressions

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test:run 2>&1 | tee /tmp/test-wrapping-regression.txt`

Expected: All existing tests pass. The change should be invisible — `_run` was already being called, it just now receives `__state` via the `AgencyFunction` wrapping instead of the ad-hoc `state?` parameter.

- [ ] **Step 2: Run the existing subprocess tests (if any pass)**

Run: `pnpm run agency test tests/agency/subprocess/run-basic.agency 2>&1 | tee /tmp/test-subprocess-basic.txt`

This test may or may not pass yet depending on the state of other subprocess infrastructure (bootstrap script, etc.). The point is to verify that the `_run` wrapping works — if it fails, it should fail for reasons other than "cannot access ctx."

- [ ] **Step 3: Check for any TypeScript compilation errors**

Run: `pnpm run build 2>&1 | tee /tmp/test-build.txt`

Expected: Clean build with no type errors.

---

## Notes for the implementer

### Key files to read first
- `docs/superpowers/specs/2026-05-09-run-receives-ctx-via-agencyfunction-wrapping.md` — the spec
- `lib/runtime/checkpoint.ts` — the existing pattern you're following (function receives `__state: InternalFunctionState`)
- `lib/templates/backends/typescriptGenerator/imports.mustache:12,66-68` — the existing wrapping you're extending
- `lib/runtime/call.ts:4-25` — the `__call` function that routes `AgencyFunction` vs raw function

### Critical invariants
- **`_run` must receive `__state` as its last parameter.** `AgencyFunction.invoke()` appends it after all declared params.
- **The `params` array in the wrapping must list only user-facing params** (`compiled`, `options`), NOT `__state`. This matches how `checkpoint` (zero params), `getCheckpoint` (one param), and `restore` (two params) are wrapped.
- **Always rebuild with `make` after changing stdlib or template files.** The template is compiled by typestache, then the stdlib `.agency` files are compiled using the updated template.
- **Handlers are safety infrastructure.** The whole point of this change is to ensure `_run` can call `interruptWithHandlers` with the parent's `ctx`, so subprocess interrupts go through the parent's handler chain.
