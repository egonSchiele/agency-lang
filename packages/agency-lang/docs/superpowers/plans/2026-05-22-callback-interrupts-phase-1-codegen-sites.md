# Callback Interrupts — Phase 1: Codegen-emitted Hook Sites (via Runner step type)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagate interrupts raised inside callback bodies for the five hook sites emitted by the typescriptBuilder (`onFunctionStart`, `onFunctionEnd`, `onEmit`, `onNodeStart`, `onNodeEnd`). When a callback halts with `Interrupt[]`, the surrounding compiled function/node must stamp a checkpoint, halt its runner, and return the interrupts up the stack so `respondToInterrupts` works end-to-end. On resume the firing site must skip already-fired hooks so they don't re-run.

**Architecture:** Add a new specialized Runner step type — `runner.hook(id, hookName, data)` — modeled exactly on the existing `runner.handle` / `runner.thread` / `runner.pipe` step types in `lib/runtime/runner.ts`. Codegen emits a single line per hook site:

```ts
await runner.hook(<id>, "onFunctionStart", { functionName: ... });
```

`Runner.hook` itself handles substep-counter resume skipping, debugger/coverage integration, the actual `callHook` call, checkpoint stamping on interrupts, and the halt protocol. This keeps the halt/checkpoint/substep machinery encapsulated inside Runner — exactly where it lives for every other step type — instead of leaking it into generated code or a one-off mustache template.

This intentionally avoids:
- A new mustache template that re-implements substep guards and halt protocol in textual form.
- A bespoke `__hookFired_<id>` flag scheme that parallels (and risks diverging from) the existing substep counter.
- Threading `moduleId` / `scopeName` strings through builders/IR/templates just to stamp a checkpoint — `Runner` already has `getCheckpointInfo()` for this.

**Tech Stack:** TypeScript runtime (`lib/runtime/runner.ts`, `lib/runtime/hooks.ts`), TypeScript codegen (`lib/backends/typescriptBuilder.ts`, `lib/ir/builders.ts`, `lib/ir/tsIR.ts`, `lib/ir/prettyPrint.ts`), generated-fixture regeneration via `make fixtures`, and agency execution tests under `tests/agency/`.

**Prerequisites:** Phase 0 (`docs/superpowers/plans/2026-05-22-callback-interrupts-phase-0-plumbing.md`) must be merged. `callHook` must return `Interrupt[] | undefined`; `callHookAndDrop` must exist for the TS-side runtime sites that can't propagate.

---

## File Structure

- **Modify:** `lib/runtime/runner.ts` — add `async hook(id, hookName, data)` method following the `handle` / `thread` shape.
- **Modify:** `lib/runtime/runner.test.ts` — unit-test the new Runner method directly (resume skip; halt-on-interrupt; checkpoint stamping; no-interrupt happy path).
- **Modify:** `lib/ir/tsIR.ts` — add `TsRunnerHook` node kind.
- **Modify:** `lib/ir/builders.ts` — add `ts.runnerHook(...)` builder. Keep existing `ts.callHook(...)` for any place that wants the raw expression (none today after Phase 1).
- **Modify:** `lib/ir/prettyPrint.ts` — render `runnerHook` as a single `await runner.hook(...)` line.
- **Modify:** `lib/backends/typescriptBuilder.ts` — replace the five `ts.callHook(...)` call sites with `ts.runnerHook(...)`. Move `onFunctionEnd` out of `finally` so its interrupts can propagate (interrupts thrown from `finally` cannot be returned cleanly).
- **Modify:** `lib/runtime/hooks.ts` — explicit reject when `onAgentStart` / `onAgentEnd` callbacks return interrupts (defensive; those sites use `callHookAndDrop`, but this catches future misuse).
- **Create:** `tests/agency/callback-interrupt-resume-onfunctionstart.{agency,test.json}` — resume roundtrip for an interrupt raised by an onFunctionStart callback.
- **Create:** `tests/agency/callback-interrupt-resume-onnodeend.{agency,test.json}` — same for onNodeEnd.
- **Create:** `tests/agency/callback-interrupt-resume-onemit.{agency,test.json}` — same for an onEmit callback.
- **Create:** `tests/agency/callback-multi-interrupt-resume.{agency,test.json}` — multiple callbacks each interrupting, both responded to, resume completes; verifies no double-fire.
- **Run:** `make fixtures` — regenerate every fixture under `tests/typescriptGenerator/` and `tests/typescriptBuilder/` to pick up the new codegen shape.

---

## Background: why a runner step type

Read `docs/dev/interrupts.md` ("Substeps" section), `docs/dev/concurrent-interrupts.md` ("Capture-time slice rule"), and `lib/runtime/runner.ts` (especially `step`, `handle`, `thread`, `pipe`) before starting.

Every other resumable construct in Agency is a Runner step type. They all share the same skeleton:

```ts
async XXX(id: number, ...args, callback?: ...): Promise<...> {
  if (this.shouldSkip()) return;
  if (this.getCounter() > id) return;
  if (await this.maybeDebugHook(id)) return;
  this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));
  this.path.push(id);
  try {
    // do the specialized work
  } finally {
    this.path.pop();
  }
  if (this.halted) return;
  this.clearDebugFlag(id);
  this.setCounter(id + 1);
}
```

This skeleton already encodes everything Phase 1 needs:

| Phase 1 requirement                                  | How the skeleton provides it                                                                 |
|------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Skip the hook on resume after it already fired       | `this.getCounter() > id` short-circuits.                                                     |
| Re-fire the hook on resume when it halted with intr  | When halt happens we **don't** call `setCounter(id + 1)`, so resume sees `counter <= id`.    |
| Debugger pause point at the hook site                | `maybeDebugHook(id)` already there.                                                          |
| Coverage hit at the hook site                        | `coverageCollector.hit` already there.                                                       |
| Correct checkpoint metadata (module/scope/stepPath)  | `getCheckpointInfo()` already there.                                                         |
| Composes with fork/race (slice-only invariant)       | Runner already operates on its local frame; checkpoint stamp goes through `__ctx.checkpoints.createPinned(this.stack, ...)` using the Runner's own stack reference. |

The only thing the skeleton doesn't already do is call `callHook` and stamp interrupt IDs onto the returned interrupts. That's the entire delta for `Runner.hook`.

---

## Task 1: Add `Runner.hook` plus unit tests

**Files:**
- Modify: `lib/runtime/runner.ts`
- Modify: `lib/runtime/runner.test.ts` (or create alongside if it doesn't exist)

- [ ] **Step 1: Read the sibling step types first**

Read `lib/runtime/runner.ts` lines 243–375 — the bodies of `step`, `pipe`, `thread`, `handle`. The new method goes alongside them, after `handle`. Match the same comment style and section banner (`// ── Specialized: hook ──`).

- [ ] **Step 2: Add `Runner.hook`**

In `lib/runtime/runner.ts`, after `handle`:

```ts
// ── Specialized: hook ──

/**
 * Fire a codegen-emitted callback hook (onFunctionStart, onFunctionEnd,
 * onEmit, onNodeStart, onNodeEnd) as a resumable substep.
 *
 * If any registered callback for `hookName` halts with `Interrupt[]`,
 * we stamp a pinned checkpoint at this substep's path and halt the
 * runner. The interrupts are returned via runner.haltResult so the
 * surrounding generated function returns them up the stack. The
 * substep counter is NOT advanced on halt, so on resume this method
 * re-enters and re-fires the hook — at which point the user's response
 * (keyed by each Interrupt's interruptId) is consulted by the callback
 * body's saved __interruptId_N local, exactly like any other interrupt
 * resume.
 *
 * If the hook returns no interrupts the substep counter advances,
 * so subsequent resumes skip the hook (no duplicate analytics events
 * after every interrupt cycle).
 */
async hook(
  id: number,
  hookName: CallbackName,
  data: Record<string, unknown>,
): Promise<void> {
  if (this.shouldSkip()) return;
  if (this.getCounter() > id) return;

  if (await this.maybeDebugHook(id)) return;

  this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

  this.path.push(id);
  try {
    const result = await callHook({ ctx: this.ctx, name: hookName, data });
    if (hasInterrupts(result)) {
      const cpId = this.ctx.checkpoints.createPinned(
        this.stack!,
        this.ctx,
        this.getCheckpointInfo(),
      );
      for (const intr of result) intr.checkpointId = cpId;
      this.halt(result);
      return;
    }
  } finally {
    this.path.pop();
  }

  if (this.halted) return;
  this.clearDebugFlag(id);
  this.setCounter(id + 1);
},
```

Add imports at the top of the file:
```ts
import { callHook } from "./hooks.js";
import type { CallbackName } from "./types.js";
```

Confirm `this.stack` is non-null at hook-fire sites. Existing step types (`fork`) use `stateStack` parameters; for `hook`, the Runner is always created with a `stack` opt from the surrounding generated function (verify by searching emitted output for `new Runner(...,{ stack: __stateStack })`). If a code path constructs a Runner without `stack`, the checkpoint stamp falls back to a non-pinned form — but the existing slice-only invariant requires the local `__stateStack`, so emit code MUST pass it. Add a defensive `if (!this.stack) throw new Error("Runner.hook requires stack opt")` to make the contract explicit at runtime.

- [ ] **Step 3: Unit-test `Runner.hook`**

In `lib/runtime/runner.test.ts`, add four cases:

1. Happy path: no callbacks registered → returns without halting, counter advances to `id+1`.
2. Resume skip: counter already past id → method is a no-op (no `callHook` call).
3. Halt on interrupts: registered callback returns `[interrupt]` → runner.halted=true, runner.haltResult is the array, every entry has `checkpointId` populated, counter does NOT advance.
4. Re-fire on resume after halt: same setup as (3), then call `runner.hook(id, ...)` again with the callback now returning `undefined` → fires, counter advances.

Use the existing test helpers in `runner.test.ts` for context/frame setup.

- [ ] **Step 4: Build + test**

```bash
make
pnpm vitest run lib/runtime/runner.test.ts 2>&1 | tee /tmp/runner-hook.log
```

Expected: all four new cases pass.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/runner.ts lib/runtime/runner.test.ts
git commit -m "Phase 1: add Runner.hook specialized step type"
```

---

## Task 2: Add the IR node + builder + prettyPrint case

**Files:**
- Modify: `lib/ir/tsIR.ts`
- Modify: `lib/ir/builders.ts`
- Modify: `lib/ir/prettyPrint.ts`

This is intentionally the same shape as `runnerHandle` / `runnerStep` — three small additions, no mustache.

- [ ] **Step 1: IR node**

In `lib/ir/tsIR.ts`, alongside `TsRunnerHandle`:

```ts
/** runner.hook(id, hookName, data) */
export type TsRunnerHook = {
  kind: "runnerHook";
  id: number;
  hookName: string;
  data: TsNode;
};
```

Add it to the `TsNode` union.

- [ ] **Step 2: Builder**

In `lib/ir/builders.ts`, alongside `runnerHandle`:

```ts
runnerHook(opts: {
  id: number;
  hookName: string;
  data: Record<string, TsNode> | TsNode;
}): TsRunnerHook {
  const dataNode = "kind" in opts.data
    ? opts.data as TsNode
    : ts.obj(opts.data as Record<string, TsNode>);
  return { kind: "runnerHook", id: opts.id, hookName: opts.hookName, data: dataNode };
},
```

- [ ] **Step 3: prettyPrint**

In `lib/ir/prettyPrint.ts`, alongside the `runnerHandle` case:

```ts
case "runnerHook": {
  const data = prettyPrint(node.data, ctx);
  return `await runner.hook(${node.id}, ${JSON.stringify(node.hookName)}, ${data});`;
}
```

- [ ] **Step 4: Build + commit**

```bash
make
git add lib/ir/tsIR.ts lib/ir/builders.ts lib/ir/prettyPrint.ts
git commit -m "Phase 1: add ts.runnerHook IR node and builder"
```

---

## Task 3: Migrate the five codegen sites in `typescriptBuilder.ts`

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

Existing sites (verified via grep):
- `:1477` `onFunctionStart`
- `:1566` `onFunctionEnd` — currently inside `finally`
- `:1823` `onEmit`
- `:2146` `onNodeStart`
- `:2172` `onNodeEnd`

Each call site needs a substep id from the surrounding `StepPathTracker` (`this.steps.currentId()` or however the surrounding code assigns ids). Read each site to find the right id source.

- [ ] **Step 1: `onFunctionStart` (line 1477)**

Replace:
```ts
ts.callHook("onFunctionStart", { functionName: ts.str(functionName) })
```
with:
```ts
ts.runnerHook({
  id: this.steps.nextId(),
  hookName: "onFunctionStart",
  data: { functionName: ts.str(functionName) },
})
```

Mirror however the surrounding code allocates ids for other step types (look at how `runnerStep` ids are allocated immediately before/after this site).

- [ ] **Step 2: `onNodeStart` (line 2146)** and **`onEmit` (line 1823)**

Same pattern. Both already live inside generated function/node bodies, so a Runner is in scope.

- [ ] **Step 3: `onNodeEnd` (line 2172)**

Same pattern. Confirm it's not inside a `finally` block; if it is, apply the same out-of-finally move as Step 4.

- [ ] **Step 4: `onFunctionEnd` (line 1566) — out of `finally`**

Today this lives in a `finally` block, gated by `__functionCompleted`. Move it onto the success path immediately before the `return` (and before `__stateStack.pop()` if it currently runs after). Two reasons:

1. You cannot return interrupts from `finally`. If a callback halts there, the halt result is lost.
2. The `__functionCompleted` flag exists only to suppress the hook on the failure (catch) path. After the move, that gating becomes explicit (don't call the hook in the catch handler) and the flag can be deleted entirely.

Concrete shape:

```ts
ts.tryCatch(
  ts.statements([
    ts.statements(body),
    ts.runnerHook({
      id: this.steps.nextId(),
      hookName: "onFunctionEnd",
      data: { functionName: ts.str(functionName), result: ts.id("__result") },
    }),
    ts.return(ts.id("__result")),
  ]),
  ts.raw(renderFunctionCatchFailure.default({ functionName: JSON.stringify(functionName) })),
  "__error",
  ts.statements([ts.raw("__stateStack.pop()")]),
)
```

Remove `__functionCompleted` decl + assignments. If the catch path historically fired `onFunctionEnd` for failure paths, add a separate `ts.runnerHook(...)` call inside the catch handler with its own substep id (see Step 6).

- [ ] **Step 5: Verify hook firing-on-failure semantics**

Search for `__functionCompleted` and any docs claiming `onFunctionEnd` fires on every exit path:

```bash
grep -rn "__functionCompleted\|onFunctionEnd" lib/ docs/ tests/agency/callback-*.agency
```

If existing tests/docs expect failure-path firing, add the catch-side `ts.runnerHook(...)`. If not, leave it success-only (matching current `__functionCompleted` gating).

- [ ] **Step 6: Build + run existing callback tests**

```bash
make
for t in tests/agency/callback-*.agency; do
  echo "=== $(basename $t) ==="
  node ./dist/scripts/agency.js test "$t" 2>&1 | tail -3
done | tee /tmp/callback-tests-task3.log
```

Expected: all 16 existing callback tests still pass. Investigate any failure before continuing.

- [ ] **Step 7: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "Phase 1: migrate codegen hook sites to runner.hook; move onFunctionEnd out of finally"
```

---

## Task 4: Reject interrupts from `onAgentStart` / `onAgentEnd`

**Files:**
- Modify: `lib/runtime/hooks.ts`
- Modify: `lib/runtime/hooks.test.ts`

`onAgentStart` and `onAgentEnd` fire from `lib/runtime/node.ts` outside any agency frame and cannot resume. They use `callHookAndDrop` so interrupts are logged and dropped — but a user registering an interrupt-raising callback on those hooks today gets silent failure. Make it loud.

- [ ] **Step 1: Failing test**

In `lib/runtime/hooks.test.ts`:

```ts
it("throws when onAgentStart or onAgentEnd callbacks raise interrupts", async () => {
  for (const hookName of ["onAgentStart", "onAgentEnd"] as const) {
    const ctx = fakeCtx();
    const intr = { kind: "x::y", message: "", data: null, origin: "x", interruptId: "i" };
    ctx.topLevelCallbacks = [{ name: hookName, fn: fakeAgencyFn([intr]) }];
    await expect(
      callHook({ ctx, name: hookName, data: {} as any }),
    ).rejects.toThrow(/cannot raise interrupts/);
  }
});
```

- [ ] **Step 2: Implement**

In `callHook` (or wherever the collected interrupt array is returned), before returning:

```ts
if (collected.length > 0 && (name === "onAgentStart" || name === "onAgentEnd")) {
  throw new Error(
    `[agency] ${name} callbacks cannot raise interrupts: the agent has ` +
      `no active frame to checkpoint, so there's nowhere for the user to ` +
      `respond from. Remove the interrupt() call from the callback body, ` +
      `or move the registration to a hook that fires inside an agency ` +
      `call frame (onFunctionStart, onNodeStart, etc.).`,
  );
}
```

- [ ] **Step 3: Run + commit**

```bash
pnpm vitest run lib/runtime/hooks.test.ts
git add lib/runtime/hooks.ts lib/runtime/hooks.test.ts
git commit -m "Phase 1: reject interrupts from onAgentStart/onAgentEnd callbacks"
```

---

## Task 5: End-to-end resume tests

**Files:**
- Create: `tests/agency/callback-interrupt-resume-onfunctionstart.{agency,test.json}`
- Create: `tests/agency/callback-interrupt-resume-onnodeend.{agency,test.json}`
- Create: `tests/agency/callback-interrupt-resume-onemit.{agency,test.json}`

Each test follows the same pattern: register a top-level callback for the hook, the callback raises an interrupt the first time and returns normally on resume, the program completes after `respondToInterrupts`. Verify that on resume the hook does NOT fire a second time (assert via a counter that increments inside the callback).

- [ ] **Step 1: Write the three tests**

Model on `tests/agency/callback-toplevel-interrupt.agency` (already in place from earlier work). One example for `onFunctionStart`:

```agency
let calls: number = 0

callback("onFunctionStart") as data {
  if (data.functionName == "doWork") {
    calls = calls + 1
    if (calls == 1) {
      interrupt myapp::pause("waiting", data)
    }
  }
}

def doWork(): string {
  return "ok"
}

node main() {
  let r: string = doWork()
  return [calls, r]
}
```

Expected after responding to `myapp::pause` once: `[1, "ok"]` (callback fired exactly once total — the resume re-enters the function and the substep counter has not advanced past the hook because the halt skipped it, then the callback re-fires, returns undefined this time, the counter advances, and execution continues).

Wait — that means `calls` would be `2`, not `1`. Re-read `Runner.hook`: on halt, the counter does NOT advance, so on resume the hook re-fires. The callback body is re-entered with its saved `__interruptId_N` matching the user's response, so the interrupt resolves without re-throwing — but the `calls = calls + 1` line outside the interrupt does run again.

Decide the expected value based on intended semantics:
- If we want "fired exactly once per logical event," then the test must read `calls == 2` and the docs must call this out (the callback body re-runs from the top on resume, like every other agency code path that resumes after an interrupt).
- If we want "fired exactly once total," then `Runner.hook` would need to set the counter eagerly before calling `callHook` — but then a callback that mid-body throws would leave the counter advanced and the resume wouldn't re-enter the callback at all. That breaks the response routing.

Correct expected value: **`calls == 2`** (the callback body re-runs after resume; `interrupt(...)` inside the body returns the user's response the second time, so the if-branch doesn't re-trigger). This matches existing interrupt semantics and is consistent with how user-written `interrupt()` calls behave today.

Document this expectation in the test fixture's `.test.json` and in `docs/dev/callback-hooks.md` (see Task 7).

- [ ] **Step 2: Run + commit**

```bash
for t in tests/agency/callback-interrupt-resume-*.agency; do
  node ./dist/scripts/agency.js test "$t" 2>&1 | tail -3
done | tee /tmp/resume-tests.log
git add tests/agency/callback-interrupt-resume-*
git commit -m "Phase 1: end-to-end resume tests for codegen hook interrupts"
```

---

## Task 6: Multi-callback resume test

**Files:**
- Create: `tests/agency/callback-multi-interrupt-resume.{agency,test.json}`

- [ ] **Step 1: Write the test**

Two callbacks on the same hook, both interrupt the first time, both respond, resume completes:

```agency
let firedA: number = 0
let firedB: number = 0

callback("onFunctionEnd") as data {
  if (data.functionName == "doWork") {
    firedA = firedA + 1
    if (firedA == 1) { interrupt myapp::a("A", data) }
  }
}

callback("onFunctionEnd") as data {
  if (data.functionName == "doWork") {
    firedB = firedB + 1
    if (firedB == 1) { interrupt myapp::b("B", data) }
  }
}

def doWork(): string { return "x" }

node main() {
  let r: string = doWork()
  return [firedA, firedB, r]
}
```

Critical invariants:
- Both interrupts surface in a single batched `Interrupt[]` (Phase 0 made `callHook` collect across callbacks).
- After responding to both, resume re-enters `doWork`, `onFunctionEnd` re-fires, both callback bodies re-run, neither re-throws (their `if (firedX == 1)` guard is false the second time), substep counter advances, `r` returns `"x"`.
- Final state: `[2, 2, "x"]`.

- [ ] **Step 2: Run + commit**

```bash
node ./dist/scripts/agency.js test tests/agency/callback-multi-interrupt-resume.agency
git add tests/agency/callback-multi-interrupt-resume.*
git commit -m "Phase 1: cover multi-callback interrupt resume on same hook"
```

---

## Task 7: Regenerate fixtures + full validation

- [ ] **Step 1: Regenerate**

```bash
make fixtures
```

Inspect the diff. Each function/node should now show `await runner.hook(<n>, "onFunctionStart", {...})` etc. in place of the old `await callHook({...})` expressions. The diff is mechanical; investigate anything that changes shape unexpectedly.

- [ ] **Step 2: Full validation**

```bash
make
pnpm run typecheck
pnpm run lint:structure
pnpm vitest run 2>&1 | tail -5 | tee /tmp/vitest.log
for t in tests/agency/callback-*.agency; do
  node ./dist/scripts/agency.js test "$t" 2>&1 | grep -E "passed|FAIL" | tail -1
done | tee /tmp/callback-final.log
```

Expected: all green. All 20 callback agency tests pass (16 existing + 4 new).

- [ ] **Step 3: Commit fixtures**

```bash
git add tests/typescriptBuilder/ tests/typescriptGenerator/
git commit -m "Phase 1: regenerate fixtures for runner.hook codegen"
```

---

## Task 8: Update docs

**Files:**
- Modify: `docs/dev/callback-hooks.md` (created in Phase 0)
- Modify: `docs/dev/interrupts.md`

- [ ] **Step 1: Update `docs/dev/callback-hooks.md`**

In the "Codegen-emitted (`ts.callHook(...)`)" section, replace the "After Phase 1" forward reference with: codegen emits `ts.runnerHook(...)`, which compiles to `await runner.hook(id, name, data)`. `Runner.hook` (in `lib/runtime/runner.ts`) handles the resume/halt/checkpoint protocol uniformly with every other Runner step type. The user-visible semantic is "if any callback for this hook interrupts, the surrounding agency frame halts and returns the interrupt batch up the stack; on resume, the hook re-fires and the callback bodies re-run with their saved interrupt-response locals."

Call out explicitly that the callback body **re-runs from the top on resume** — same as every other agency code path that resumes after an interrupt. Counters and other observable side effects inside the callback body will appear to run twice for an interrupted callback.

Note the asymmetry with `callHookAndDrop` (still used by TS-runtime sites) and the explicit reject for `onAgentStart` / `onAgentEnd`.

- [ ] **Step 2: Add a section to `docs/dev/interrupts.md`**

Under "Substeps", add:

```markdown
## Callback hook firing

Codegen-emitted hook sites (onFunctionStart, onFunctionEnd, onEmit,
onNodeStart, onNodeEnd) are compiled as a specialized Runner step type:
`Runner.hook(id, hookName, data)` in lib/runtime/runner.ts.

The step type follows the same skeleton as Runner.handle / Runner.thread:
substep-counter resume-skipping, debugger pause, coverage hit, halt
protocol. The hook-specific piece is calling callHook(...) and, if any
callback halts with Interrupt[], stamping a pinned checkpoint at the
substep path and halting the runner without advancing the counter so
resume re-fires the hook.

See lib/runtime/runner.ts (`hook` method) and docs/dev/callback-hooks.md
for the full semantics.
```

- [ ] **Step 3: Commit**

```bash
git add docs/dev/callback-hooks.md docs/dev/interrupts.md
git commit -m "Phase 1: document Runner.hook step type"
```

---

## Final validation + PR

- [ ] **Step 1: Inspect the commit log**

```bash
git log --oneline origin/main..HEAD
```

Expected: ~10 commits, one per task. Squash at PR-merge time per team convention.

- [ ] **Step 2: Push + open PR**

PR description should explicitly note:
- Builds on Phase 0 (the plumbing PR).
- New Runner step type `runner.hook(...)` propagates callback interrupts at the five codegen-emitted hook sites. The substep machinery (resume-skip, halt, checkpoint stamping) is inherited from the existing Runner skeleton — no bespoke flags, no new mustache, no leaky abstraction in generated code.
- `onFunctionEnd` moves out of `finally` so its interrupts can propagate. Success-vs-failure firing semantics are preserved.
- `onAgentStart` / `onAgentEnd` callbacks now throw if they raise interrupts (previously silently logged and dropped).
- LLM/tool hooks (onLLMCallStart, onLLMCallEnd, onToolCallStart, onToolCallEnd) still use `callHookAndDrop` — Phase 2 covers those (`runPrompt` needs to be split into agency-callable pieces first).
- Fixtures regenerated; the diff is mechanical and reflects the new `await runner.hook(...)` codegen.

---

## Out of scope for Phase 1

- LLM/tool hook propagation. See the Phase 2 research notes: the TS-side runtime sites in `lib/runtime/prompt.ts` need to be split so callback firing happens inside agency code (where Runner is in scope) instead of mid-TS-function. That work is its own plan.
- Removing `callHookAndDrop`. The agent-start/end sites fundamentally can't resume; they keep using `callHookAndDrop` permanently. The prompt.ts sites migrate in Phase 2.
- Optimizing substep-id allocation. The current scheme uses `this.steps.nextId()` which assigns ids in source order. Compression is a future refactor.

---

## Risks worth flagging during review

- **Test fixture churn.** `make fixtures` will rewrite ~100 `.mjs` files. The diff should be one-line per old `callHook` call replaced by a `runner.hook` call. If anything else changes shape, investigate before merging.
- **`onFunctionEnd` semantics.** Moving out of `finally` changes when it fires on the failure path. Existing tests + Step 5 of Task 3 must explicitly cover both success and failure path firing.
- **Callback body re-runs on resume.** Document this loudly in `docs/dev/callback-hooks.md`. Users who put non-idempotent side effects in callback bodies will be surprised. This matches existing agency semantics; the hook layer doesn't change it.
- **`this.stack` requirement in Runner.hook.** The checkpoint stamp uses `this.stack!`. All codegen-emitted Runners pass a `stack` opt, but verify with grep before merging. The defensive `if (!this.stack) throw` in Task 1 makes violations loud.
- **Hook firing inside an interrupt handler.** A callback body that interrupts inside an enclosing `handle` block still hits the live handler stack at firing time (existing Phase 0 behavior, unchanged). The new propagation only kicks in for *un*handled interrupts.
