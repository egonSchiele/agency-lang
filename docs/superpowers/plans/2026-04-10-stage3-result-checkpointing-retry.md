# Result Checkpointing and Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Dependency:** This plan depends on Stage 1 (Result type foundations) being complete. Stage 1 creates `lib/runtime/result.ts` with `success()`, `failure()`, `isSuccess()`, `isFailure()`. Do not begin this plan until Stage 1 is merged.

**Goal:** Add automatic checkpointing at Result-returning function entry, embed checkpoints in failure objects, extend RestoreOptions for argument overrides, and implement the `result.retry()` compiler desugaring.

**Architecture:** The builder detects Result-returning functions and emits a pinned checkpoint creation after the setup block at function entry. `failure()` is updated to accept a checkpoint — but this is purely a builder concern; in Agency source code, users write `failure("error")` with one argument, and the builder injects the checkpoint as the second argument in generated code. `RestoreOptions` gains `args` and `globals` fields. `result.retry(newArgs)` is desugared by the builder into `restore(checkpoint, { args })`. Retry limits are enforced via `CheckpointStore.trackRestore()` using the existing `maxRestores` mechanism, configured through `result.maxRetries`. Typechecker rules for `.retry()` validation are deferred to Stage 7 (consolidated typechecker work).

**Tech Stack:** TypeScript, vitest (testing)

---

## Task 1: Extend `RestoreOptions` with `args` and `globals` fields

- [ ] In `lib/runtime/errors.ts`, update the `RestoreOptions` type:
  ```typescript
  export type RestoreOptions = {
    messages?: MessageJSON[];
    args?: any[];
    globals?: Record<string, Record<string, any>>;
  };
  ```
- [ ] Add unit tests in `lib/runtime/errors.test.ts` (or co-located test file) verifying that `RestoreSignal` can be constructed with the new fields and that they are accessible on the instance:
  ```typescript
  const cp = { id: 1, stack: {}, globals: {}, nodeId: "n", moduleId: "m", scopeName: "s", stepPath: "", label: undefined, pinned: false } as any;
  const signal = new RestoreSignal(cp, { args: [1, 2], globals: { mod: { x: 10 } } });
  expect(signal.options?.args).toEqual([1, 2]);
  expect(signal.options?.globals).toEqual({ mod: { x: 10 } });
  ```
- [ ] Run: `pnpm vitest run lib/runtime/errors`

---

## Task 2: Apply argument and globals overrides in state restoration

When restoring from a checkpoint with `args` or `globals` in `RestoreOptions`, these overrides must be applied.

**Argument overrides:** Function arguments are regular TypeScript parameters — they are NOT read from the stack frame by `setupFunction`. The correct approach is to store pending arg overrides on the `RuntimeContext` and apply them in the generated function preamble.

- [ ] In `lib/runtime/state/context.ts`, add an optional `_pendingArgOverrides?: any[]` field to `RuntimeContext`.
- [ ] In `lib/runtime/node.ts`, in the `catch (e)` block that handles `RestoreSignal`, after calling `execCtx.restoreState(cp)`, add logic to apply both argument and globals overrides:
  ```typescript
  if (e instanceof RestoreSignal) {
    const cp = e.checkpoint;
    execCtx.restoreState(cp);
    if (e.options?.args) {
      execCtx._pendingArgOverrides = e.options.args;
    }
    if (e.options?.globals) {
      execCtx.globals.patchGlobals(e.options.globals);
    }
    // ... existing audit, reset state ...
  }
  ```
- [ ] In `lib/backends/typescriptBuilder.ts`, in `processFunctionDefinition()`, for Result-returning functions, emit a preamble step in the generated function setup code that checks for pending arg overrides and applies them to the local parameter variables:
  ```typescript
  // Generated code in the function preamble:
  if (__ctx._pendingArgOverrides) {
    [param1, param2, ...] = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = undefined;
  }
  ```
  The builder knows the parameter names from the function definition, so it can emit the destructuring assignment.
- [ ] In `lib/runtime/state/globalStore.ts`, add a `patchGlobals(overrides: Record<string, Record<string, any>>)` method to `GlobalStore`:
  ```typescript
  patchGlobals(overrides: Record<string, Record<string, any>>): void {
    for (const [moduleId, vars] of Object.entries(overrides)) {
      for (const [varName, value] of Object.entries(vars)) {
        this.set(moduleId, varName, value);
      }
    }
  }
  ```
- [ ] Add unit tests:
  - In `lib/runtime/state/context.test.ts` (or co-located): verify `_pendingArgOverrides` can be set and cleared.
  - In `lib/runtime/state/globalStore.test.ts`: Create a GlobalStore, initialize a module, call `patchGlobals({ mod: { x: 42 } })`, verify `get("mod", "x")` returns 42. Verify patching a non-existent module creates it or handles it gracefully.
- [ ] Run: `pnpm vitest run lib/runtime/state/globalStore` and `pnpm vitest run lib/runtime/state/context`

---

## Task 3: Update `failure()` to accept an optional checkpoint parameter

**Note:** In Agency source code, users write `failure("error")` with one argument. The builder (Task 5) is responsible for injecting the checkpoint as the second argument in generated code. The user never sees or passes the checkpoint.

- [ ] In `lib/runtime/result.ts`, update the `failure()` function signature:
  ```typescript
  export function failure(error: any, checkpoint?: any): ResultFailure {
    return { success: false, error, checkpoint: checkpoint ?? null };
  }
  ```
- [ ] Add unit tests in `lib/runtime/result.test.ts`:
  - `failure("bad")` produces `{ success: false, error: "bad", checkpoint: null }`.
  - `failure("bad", someCp)` produces `{ success: false, error: "bad", checkpoint: someCp }`.
  - `isFailure(failure("bad", cp))` returns `true`.
- [ ] Run: `pnpm vitest run lib/runtime/result`

---

## Task 4: Builder — auto-checkpoint at Result-returning function entry

The builder must detect when a function's return type is `Result` and emit a pinned checkpoint creation at function entry.

**Important:** The checkpoint creation must go AFTER the `setupEnv` block in the generated code, so `__ctx` and `__state` are properly initialized.

- [ ] In `lib/backends/typescriptBuilder.ts`, in `processFunctionDefinition()`, after the existing setup code (setupFunction, setupEnv, audit calls, etc.), add a check:
  ```typescript
  if (node.returnType && isResultType(node.returnType)) {
    // Emit: const __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { ... });
  }
  ```
- [ ] Create a helper `isResultType(type: AgencyType): boolean` in `lib/backends/utils.ts` (or inline in the builder) that checks whether a type node represents `Result` or `Result<T, E>`.
- [ ] Emit the checkpoint creation using `createPinned()` (not `create()`) so that Result checkpoints survive `deleteAfterCheckpoint()` calls and garbage collection. Use the IR builder:
  ```typescript
  ts.constDecl("__resultCheckpointId", ts.call("__ctx.checkpoints.createPinned", [
    ts.id("__ctx"),
    ts.object({ nodeId: ts.string(nodeId), moduleId: ts.string(moduleId), scopeName: ts.string(scopeName), label: ts.string("result-entry") })
  ]))
  ```
  This must be wrapped in a step so it participates in the step counter system for interrupt/restore support.
- [ ] Update the imports template (`lib/templates/backends/`) so generated code can access `createPinned` and any other checkpoint functions needed by the new generated code. Verify that the runtime imports in compiled output include the necessary checkpoint-related symbols.
- [ ] Add a unit test fixture in `tests/typescriptBuilder/` with a `.agency` file containing a Result-returning function:
  ```
  function validate(input: string) -> Result<string, string>:
    if input == "":
      return failure("empty input")
    return success(input)
  ```
  And a corresponding `.mts` fixture showing the expected generated code includes the pinned checkpoint creation at function entry (after setup).
- [ ] Run: `pnpm vitest run tests/typescriptBuilder`

---

## Task 5: Builder — emit `failure()` with checkpoint in Result-returning functions

When generating code for `failure(error)` inside a Result-returning function, the builder must pass the stored checkpoint.

- [ ] In `lib/backends/typescriptBuilder.ts`, when processing a `failure()` call expression inside a function whose return type is `Result`, transform the call:
  - Original Agency: `failure(errorExpr)`
  - Generated TS: `failure(errorExpr, __ctx.checkpoints.get(__resultCheckpointId))`
- [ ] The detection logic: when processing a call expression node where the callee is `failure`, check if the enclosing function definition has a Result return type. If so, append the checkpoint argument.
- [ ] Update the fixture from Task 4 to verify that `failure("empty input")` compiles to `failure("empty input", __ctx.checkpoints.get(__resultCheckpointId))`.
- [ ] Run: `pnpm vitest run tests/typescriptBuilder`

---

## Task 6: Add `result.maxRetries` config

Retry limits are enforced through the existing `CheckpointStore.trackRestore()` mechanism, which tracks restore counts per checkpoint ID and throws `CheckpointError` when exceeding `maxRestores`. The `result.maxRetries` config feeds into `maxRestores` for Result checkpoints.

- [ ] In `lib/config.ts`, add to `AgencyConfig`:
  ```typescript
  result?: {
    maxRetries?: number;  // default: 50
  };
  ```
- [ ] In the config defaults/resolution logic in `lib/config.ts`, set the default for `result.maxRetries` to 50.
- [ ] In the builder (Task 4), when emitting the `createPinned()` call for Result-returning function entry, pass the `maxRestores` value from config so the checkpoint store can enforce the limit:
  ```typescript
  // The CheckpointStore.trackRestore() mechanism already throws CheckpointError
  // when maxRestores is exceeded. Configure maxRestores on the CheckpointStore
  // using the result.maxRetries config value.
  ```
  If `CheckpointStore` does not yet support per-checkpoint `maxRestores`, update it to accept an optional `maxRestores` in `createPinned()` options, or set it globally from the config before checkpoint creation.
- [ ] Add unit tests in `lib/config.test.ts` (or co-located test file) verifying that the default is 50 and that a user-provided value overrides it.
- [ ] Run: `pnpm vitest run lib/config`

---

## Task 7: Builder — desugar `result.retry()` to `restore()` call

`result.retry(arg1, arg2)` is not a real method — the compiler must recognize it and desugar it.

- [ ] In `lib/backends/typescriptBuilder.ts`, when processing a method call expression, detect the `.retry(...)` pattern:
  - The receiver is a variable of type `Result` (or `ResultFailure`)
  - The method name is `retry`
  - This appears inside an `isFailure()` guard (the typechecker enforces this, but the builder can assume it)
- [ ] Desugar to:
  ```typescript
  restore(receiverVar.checkpoint, { args: [arg1, arg2] }, __state)
  ```
  Using the IR builder:
  ```typescript
  ts.call("restore", [
    ts.member(ts.id(receiverVarName), "checkpoint"),
    ts.object({ args: ts.array([...argNodes]) }),
    ts.id("__state"),
  ])
  ```
- [ ] No separate retry counter is needed. The `restore()` call internally invokes `CheckpointStore.trackRestore()`, which already tracks restore counts per checkpoint ID and throws `CheckpointError` when the `maxRestores` limit (configured via `result.maxRetries` in Task 6) is exceeded. Since the checkpoint is created with `createPinned()`, it persists across restores, and the restore count accumulates correctly.
- [ ] Add a builder fixture in `tests/typescriptBuilder/`:
  ```
  function process(input: string) -> Result<string, string>:
    let result = validate(input)
    if isFailure(result):
      result.retry("fallback")
    return result
  ```
  Verify it compiles to the `restore(result.checkpoint, { args: ["fallback"] }, __state)` pattern (no local retry counter).
- [ ] Run: `pnpm vitest run tests/typescriptBuilder`

---

## Task 8: Integration test fixtures

- [ ] Create `tests/typescriptGenerator/result-checkpoint.agency`:
  ```
  function validate(input: string) -> Result<string, string>:
    if input == "":
      return failure("empty")
    return success(input)
  ```
- [ ] Create the corresponding `tests/typescriptGenerator/result-checkpoint.mts` with the expected compiled output showing:
  - `__resultCheckpointId` creation at function entry
  - `failure("empty", __ctx.checkpoints.get(__resultCheckpointId))` in the failure branch
  - `success(input)` unchanged
- [ ] Create `tests/typescriptGenerator/result-retry.agency`:
  ```
  function process(input: string) -> Result<string, string>:
    let result = validate(input)
    if isFailure(result):
      result.retry("default")
    return success(result.value)
  ```
- [ ] Create the corresponding `tests/typescriptGenerator/result-retry.mts` with expected output showing the `restore()` desugaring.
- [ ] Run: `pnpm vitest run tests/typescriptGenerator`

---

## Task 9: E2E test — retry with new arguments

- [ ] Create `tests/agency/result-retry.agency`:
  ```
  shared attempt = 0

  function flaky(input: string) -> Result<string, string>:
    attempt = attempt + 1
    if attempt < 3:
      return failure("not yet")
    return success(input)

  node main:
    let result = flaky("hello")
    if isFailure(result):
      result.retry("hello")
    return result.value
  ```
  Note: `shared` (not `global`) is used for `attempt` because shared variables are not serialized/restored — they persist across retries. A `global` variable would be restored to its checkpointed value on each retry, resetting the counter and causing an infinite loop.
- [ ] Create `tests/agency/result-retry.test.ts`:
  ```typescript
  import { describe, it, expect } from "vitest";
  import { compileAndRun } from "../helpers";

  describe("result retry", () => {
    it("retries until success", async () => {
      const result = await compileAndRun("tests/agency/result-retry.agency");
      expect(result).toBe("hello");
    });

    it("tracks attempt count across retries", async () => {
      // The shared `attempt` should be 3 after successful execution
      // (shared vars persist across restores, unlike globals which are restored)
      const result = await compileAndRun("tests/agency/result-retry.agency");
      expect(result).toBe("hello");
    });

    it("throws when retry limit exceeded", async () => {
      // Create a program that always fails, exceeding result.maxRetries
      await expect(
        compileAndRun("tests/agency/result-retry-limit.agency", {
          config: { result: { maxRetries: 3 } },
        })
      ).rejects.toThrow(/retry limit/i);
    });
  });
  ```
- [ ] Create `tests/agency/result-retry-limit.agency`:
  ```
  function alwaysFails(input: string) -> Result<string, string>:
    return failure("nope")

  node main:
    let result = alwaysFails("hello")
    if isFailure(result):
      result.retry("hello")
    return result.value
  ```
- [ ] Run: `pnpm vitest run tests/agency/result-retry`

---

**Deferred to Stage 7:** Typechecker enforcement for `.retry()` usage (must be called on a Result inside an `isFailure()` guard, arity matching against the originating function) is consolidated in Stage 7.
