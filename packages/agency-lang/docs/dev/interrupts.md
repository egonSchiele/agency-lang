# How interrupts resume inside blocks (substeps)

## Background

Agency uses a step-counter system to resume execution after an interrupt. Every statement in a node or function body gets wrapped in a step guard:

```typescript
if (__step <= 0) {
  // statement 0
  __stack.step++;
}
if (__step <= 1) {
  // statement 1
  __stack.step++;
}
```

When an interrupt fires, `__stack.step` is serialized. On resume, statements with lower indices are skipped, and execution picks up at the right statement.

This works well for top-level statements, but blocks (if/else, loops, threads, etc.) were originally treated as a single step. The entire block body was one step, so interrupts inside a block couldn't resume at the correct statement within that block.

**Substeps** solve this by adding nested step guards inside block bodies.

## The subStepPath

All substep tracking is built on `_subStepPath`, an array that tracks the current position in the step hierarchy. It works like a scope stack:

- `processBodyAsParts` pushes the step index before processing each statement and pops after
- `processIfElseWithSteps` pushes the statement index before processing each branch body statement and pops after
- Loop and thread processors do the same for their body statements

The path is used to generate unique variable names. For example, `_subStepPath = [3, 1]` produces variables like `__substep_3_1`, `__condbranch_3_1`, etc. This ensures nested blocks at different positions never collide.

The path is also used as the branch key for async function calls. When `forkBranchSetup` is called, it uses `_subStepPath.join("_")` as the key to store/retrieve branch state in `__stack.branches`.

## If/else blocks

If/else blocks use two tracking variables:

- `__condbranch_K` — which branch was taken (integer: 0 for if, 1 for first else-if, etc., -1 if no branch matched)
- `__substep_K` — which statement within the taken branch we're on

The generated code:

1. **Evaluates the condition once** and stores the result in `__condbranch_K`. On resume, the stored value is used instead of re-evaluating the condition.
2. **Dispatches to the correct branch** using the stored condbranch value.
3. **Wraps each statement** in the branch body with a substep guard (`if (__sub_K <= N)`).

```typescript
if (__stack.locals.__condbranch_3 === undefined) {
  if (condition1) {
    __stack.locals.__condbranch_3 = 0;
  } else if (condition2) {
    __stack.locals.__condbranch_3 = 1;
  } else {
    __stack.locals.__condbranch_3 = -1;
  }
}
const __condbranch_3 = __stack.locals.__condbranch_3;
const __sub_3 = __stack.locals.__substep_3 ?? 0;

if (__condbranch_3 === 0) {
  if (__sub_3 <= 0) {
    // first statement in the if body
    __stack.locals.__substep_3 = 1;
  }
  if (__sub_3 <= 1) {
    // second statement
    __stack.locals.__substep_3 = 2;
  }
} else if (__condbranch_3 === 1) {
  // else-if body statements with their own substep guards
}
```

The condbranch value is immutable once set — `modifyInterrupt` does not cause branch conditions to be re-evaluated.

The IR node for this is `TsIfSteps` (defined in `lib/ir/tsIR.ts`), with code generation handled by Mustache templates (`ifStepsCondbranch.mustache` and `ifStepsBranchDispatch.mustache`).

## Match blocks

Match blocks reuse `TsIfSteps`, exactly like if/else: `processMatchBlockWithSteps` (`lib/backends/typescriptBuilder.ts`) turns each match case into a branch with an `===` equality condition against the scrutinee, and the `_` case (if present) becomes the else branch. Arm bodies are processed through `processBodyAsParts`, the same helper if/else uses, so each statement in an arm gets its own `__substep_K` guard — a multi-statement block arm resumes mid-arm exactly like a multi-statement if/else branch resumes mid-branch. The `__condbranch_K` cache means the winning arm is decided once and re-dispatched to (not re-matched) on resume, even if the scrutinee or a guard has side effects.

Code generation goes through the same `runnerIfElse.mustache` template used for if/else (there is no separate match-specific template).

### Match *expressions*

When a match is used as an expression (`const x = match(...) { ... }` or `return match(...) { ... }`), the lowered `TsIfSteps`/`runner.ifElse(...)` call additionally carries a `matchId`, and each arm's yielding `return expr` lowers to a `matchYield` node that compiles to:

```typescript
runner.exitMatch(<matchId>, <value>);
return;
```

`Runner.exitMatch(matchId, value)` (`lib/runtime/runner.ts`) does two things: it writes `value` into the frame local `__matchval_<matchId>` (so it lives in `__stack.locals`, not a bare `let`, and survives interrupt serialization), and it sets a private `_matchExit = matchId` flag. That flag is checked by `shouldSkip()` right alongside `_break`/`_continue` — while it's set, every subsequent runner construct (steps, nested `ifElse`, loop iterations) short-circuits, exactly like an in-flight `breakLoop()`. This unwinds through the rest of the arm and out to the match's own `runner.ifElse(...)` call, which is the only site that owns the id: its `finally` block clears `_matchExit` (`if (opts.matchId !== undefined && this._matchExit === opts.matchId) this._matchExit = null`), so code after the match resumes normally. An `ifElse` that doesn't own the pending id (an outer if/else or loop the match is nested in) leaves the flag set and keeps propagating.

`_matchExit`, like `_break`/`_continue`, is transient in-process unwind state and is **never serialized** — an interrupt cannot fire while a match-exit unwind is in flight, only in between statements.

The consuming statement (the `const x = ...` or `return ...` around the match) reads `__matchval_<matchId>` back out of `__stack.locals`. **No end-of-iteration reset is needed for `__matchval_<matchId>`**, unlike `__condbranch_`/`__substep_`/`__iteration_`: the all-paths-yield check (enforced at lowering time — every code path through an expression-position arm must `return` a value) guarantees the local is freshly written before it's ever read in the same pass through the match, so a stale value from a previous loop iteration can never leak through unread. (Loop-iteration resets for `__condbranch_`/`__substep_`/`__iteration_` themselves are implemented directly in `lib/runtime/runner.ts` — in `loop()` and `whileLoop()`, via `this.frame.clearLocalsWithPrefix(...)` calls after each iteration — not in a Mustache template; `runnerIfElse.mustache` is the only template involved in match/if-else codegen.)

Interrupt walkthrough for an expression-position match:

```agency
const val = match(r) {
    success(v) => {
        print(v)                     // substep 0
        const ok = interrupt("ok?")  // substep 1 — pauses here
        return "${v}:${ok}"          // substep 2 — calls runner.exitMatch
    }
    failure(e) => e.message
}
```

Pausing at the `interrupt` serializes `__stack.step`, `__condbranch_K = 0` (the `success` arm), `__substep_K = 1`, and locals. On resume: outer guards skip completed statements; the cached condbranch re-enters the `success` arm without re-matching `r`; the substep guard skips `print`; the interrupt statement completes with the response; the `return` statement calls `runner.exitMatch(matchId, ...)`, writing `__matchval_<matchId>` and setting `_matchExit`; the owning `ifElse` call's `finally` clears the flag; the outer `const val = __matchval_<matchId>` statement reads the value. Checkpoint/`restore()` behave identically to if/else since all of this tracking lives on `__stack`.

## Thread blocks

Thread blocks use `TsThreadSteps` with three phases:

- **Setup (substep 0):** `__threads.create()` + `__threads.pushActive(__tid)` — creates the thread and pushes it onto the active stack
- **Body (substeps 1..N):** Each statement in the thread body gets its own substep guard
- **Cleanup:** `__threads.active().cloneMessages()` (if assigned) + `__threads.popActive()` — runs after all substeps complete

```typescript
const __sub_K = __stack.locals.__substep_K ?? 0;
if (__sub_K <= 0) {
  const __tid = __threads.create();
  __threads.pushActive(__tid);
  __stack.locals.__substep_K = 1;
}
if (__sub_K <= 1) {
  // first body statement
  __stack.locals.__substep_K = 2;
}
// ... more body substeps ...
msgs = __threads.active().cloneMessages();
__threads.popActive();
```

On resume, the ThreadStore is deserialized with the thread already on the `activeStack`, so setup (substep 0) is skipped and the thread is already active. The cleanup only runs after all substeps complete.

The IR node is `TsThreadSteps`, with code generation handled by `threadSteps.mustache`.

## While loops

While loops are the most complex because the body executes multiple times. They use two tracking variables:

- `__iteration_K` — which iteration we're on (persisted in locals, survives serialization)
- `__substep_K` — which statement within the current iteration

The generated code:

```typescript
__stack.locals.__iteration_K = __stack.locals.__iteration_K ?? 0;
let __currentIter_K = 0;
while (condition) {
  // Skip completed iterations
  if (__currentIter_K < __stack.locals.__iteration_K) {
    __currentIter_K++;
    continue;
  }
  // Substep guards for body statements
  __stack.locals.__substep_K = __stack.locals.__substep_K ?? 0;
  if (__stack.locals.__substep_K <= 0) {
    // first body statement
    __stack.locals.__substep_K = 1;
  }
  if (__stack.locals.__substep_K <= 1) {
    // second body statement
    __stack.locals.__substep_K = 2;
  }
  // End-of-iteration reset
  __stack.locals.__substep_K = 0;
  __stack.clearLocalsWithPrefix("__condbranch_K_");
  __stack.clearLocalsWithPrefix("__substep_K_");
  __stack.clearLocalsWithPrefix("__iteration_K_");
  __stack.locals.__iteration_K++;
  __currentIter_K++;
}
```

### How iteration skipping works

`__iteration_K` is stored in `__stack.locals` and survives serialization. `__currentIter_K` is a local `let` variable that starts at 0 each time the loop runs (including on resume). On each iteration, if `__currentIter_K < __iteration_K`, the iteration was already completed — we increment the counter and `continue` to skip it.

When we reach the iteration where the interrupt happened, `__currentIter_K === __iteration_K`, so we fall through to the substep guards. The substep counter guides execution to the exact statement where the interrupt occurred.

### Why we re-evaluate the loop condition on skipped iterations

During skipped iterations, the while loop condition is still evaluated. This is necessary because the loop variable (e.g., `x`) is restored from serialized locals and must satisfy the condition to enter the loop at all. The condition evaluation is cheap (it's just a comparison) and ensures correctness.

### How end-of-iteration reset works

At the end of each iteration, three things happen:

1. `__substep_K` is reset to 0 for the next iteration
2. `__stack.clearLocalsWithPrefix(...)` deletes all nested tracking variables
3. `__iteration_K` is incremented

**The reset is critical for correctness.** Without it, tracking variables from a previous iteration would persist and cause incorrect behavior on the next iteration. For example, a `__condbranch_K_0` value cached from iteration 0 (where `x == 0`) would prevent the condition from being re-evaluated on iteration 3 (where `x == 3`).

`clearLocalsWithPrefix` (defined as a method on the `State` class in `lib/runtime/state/stateStack.ts`) iterates over all keys in `__stack.locals` and deletes any that start with the given prefix. Three prefixes are cleared:

- `__condbranch_K_` — cached branch decisions from if/else and match blocks
- `__substep_K_` — substep counters from nested blocks
- `__iteration_K_` — iteration counters from nested loops

This prefix-based approach is deliberately broad. Rather than enumerating specific keys to reset (which is fragile and breaks when new tracking variable types are added), it clears everything that belongs to the loop's scope.

**If you add a new type of tracking variable in the future** (e.g., `__newthing_K_0`), you must either:
- Use one of the existing prefixes (`__condbranch_`, `__substep_`, `__iteration_`), in which case it will be automatically cleared
- Add a new `clearLocalsWithPrefix` call to the loop templates (`whileSteps.mustache` and `forSteps.mustache`) with the new prefix

Failing to do so will cause the variable to persist across loop iterations, leading to incorrect resume behavior after interrupts.

The IR node is `TsWhileSteps`, with code generation handled by `whileSteps.mustache`.

## For loops

For loops use `TsForSteps`, which is structurally identical to `TsWhileSteps` but with explicit init/condition/update expressions in a `for` header instead of a `while` condition.

All three for-loop forms (range, indexed, basic for-each) are converted to C-style indexed loops for substep support:

- **Range:** `for (i in range(5))` → `for (let i = 0; i < 5; i++)`
- **Indexed:** `for (item, idx in items)` → `for (let idx = 0; idx < items.length; idx++)` with `const item = items[idx]` at the start of each iteration
- **Basic for-each:** `for (item in items)` → `for (let __i_K = 0; __i_K < items.length; __i_K++)` with `const item = items[__i_K]` at the start of each iteration

The basic for-each form is converted to an indexed loop because iteration tracking requires a numeric counter. The internal index variable `__i_K` is generated by the builder and not visible to user code.

The iteration skipping, substep guards, and end-of-iteration reset all work identically to while loops.

The IR node is `TsForSteps`, with code generation handled by `forSteps.mustache`.

## Callback hook firing

Codegen-emitted hook sites (`onFunctionStart`, `onFunctionEnd`,
`onNodeStart`, `onNodeEnd`, `onEmit`) are wrapped in
`await runner.hook(id, async () => { await callHook({ ctx, name, data }) })`.
The `runner.hook` wrapper advances the substep counter (so the hook
fires exactly once across resume cycles) but intentionally skips the
debug hook — codegen-emitted hook sites have no user-visible source
line, so pausing on one would surprise the debugger user.

Callback bodies cannot raise interrupts: the typechecker rejects any
`interrupt` statement inside a `callback(...) { ... }` body (see
`checkCallbackBodyInterrupts`). A callback that throws a JS error is
caught and logged by `fireWithGuard` in `lib/runtime/hooks.ts` —
control flow continues to the next registered callback.

## Overriding local variables when resuming from an interrupt

All interrupt response functions (`approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`) accept an optional `overrides` parameter that lets you modify local variables in the execution state before resuming.

This is useful when you want to both respond to the interrupt *and* correct a value that was computed earlier in the execution.

### API

Each function takes an options object as its last parameter:

```ts
approveInterrupt(interrupt, { overrides: { mood: "happy" } });
rejectInterrupt(interrupt, { overrides: { retryCount: 0 } });
resolveInterrupt(interrupt, resolvedValue, { overrides: { mood: "happy" } });
modifyInterrupt(interrupt, newArgs, { overrides: { mood: "happy" } });
```

### What you can override

The `overrides` parameter is `Record<string, unknown>`. It sets values in the local variables of the stack frame where the interrupt occurred. You can override any local variable that exists at that point:

```ts
// Override the result of a previous LLM call
approveInterrupt(interrupt, {
  overrides: { mood: "happy", confidence: "high" },
});
```

### Example

```agency
node main(message: string) {
  mood: "happy" | "sad" = llm("Categorize: ${message}")
  result = interrupt("Confirm mood: ${mood}")
  response: string = llm("Respond to ${mood} user")
  return { mood, response }
}
```

From TypeScript:

```ts
import { main, approveInterrupt, isInterrupt } from "./agent.js";

const result = await main("I feel fine");

if (isInterrupt(result.data)) {
  // The LLM said "sad" but we want to correct it to "happy"
  // AND approve the interrupt
  const fixed = await approveInterrupt(result.data, {
    overrides: { mood: "happy" },
  });
  console.log(fixed.data.mood); // "happy"
}
```

The override is applied to the checkpoint state before execution resumes, so the subsequent LLM call sees `mood = "happy"`.

### Implementation

Overrides are applied via the shared `applyOverrides` helper in `lib/runtime/rewind.ts`. The interrupt response functions in `lib/runtime/interrupts.ts` call `applyOverrides` after getting the checkpoint but before calling `restoreState`.

## Key files

| File | Role |
|------|------|
| `lib/ir/tsIR.ts` | IR node definitions (e.g. `TsIf`, `TsFor`, `TsWhile`) |
| `lib/ir/builders.ts` | Factory functions for IR nodes |
| `lib/ir/prettyPrint.ts` | Code generation for each IR node kind |
| `lib/backends/typescriptBuilder.ts` | `processIfElseWithSteps`, `processMessageThread`, `processWhileLoopWithSteps`, `processForLoopWithSteps`, `processMatchBlockWithSteps` |
| `lib/runtime/state/stateStack.ts` | `State.clearLocalsWithPrefix()` for loop reset |
| `lib/templates/backends/typescriptGenerator/` | Mustache templates: `blockSetup`, `runnerIfElse`, `imports`, etc. |
| `tests/agency/substeps/` | Integration tests for all block types |

## Handler verdicts, merge, and registration-site scoping

Three pieces of the handler chain live in the runtime (added for the
resumable-guards work; see `docs/superpowers/plans/2026-07-16-resumable-guards.md`):

**The `pass()` verdict.** A handler that returns nothing means "no
opinion." `pass()` is the same verdict as a value, so match arms can
express it. The chain normalizes `undefined` to `{type: "pass"}` the
moment a handler returns (`runHandlerChain`, `lib/runtime/interrupts.ts`),
so statelog and the verdict logic only ever see one spelling.

**Per-effect approval merge.** When several handlers approve one
interrupt, the values combine through `mergeFor(effect)`
(`lib/runtime/effectMerge.ts`). The table is total and CONSTANT — no
registration surface, on purpose: a runtime registry would be per-run
state in a module global, it would silently diverge across the subprocess
boundary, and user merge closures would sit on the function-refs-across-
checkpoints surface. The default merge reproduces the historical
outer-overwrites behavior byte-for-byte; `std::guard` accumulates. The
cross-process path (`mergeChainOutcomes`) uses the same table via
`mergeForIpc`, whose default differs one notch (a valueless outer approve
defers to the inner value, because JSON cannot distinguish "no value"
from an explicit undefined).

**Registration-site scoping.** Every handler entry on `ctx.handlers`
carries `liveGuardIds` — the guard ids live on the registering branch's
stack at registration time (`HandlerEntry`, `lib/runtime/types.ts`).
While a handler runs, the raising branch suspends every installed guard
NOT in that set (`StateStack.beginHandlerSuspension`): the handler's own
work is metered by its registration site's guards only. Key mechanics,
each load-bearing:

- The capture point is `Runner.handle` (`lib/runtime/runner.ts`) — the
  path Agency `handle` blocks actually take. TS callers capture at call
  time in `withPushedHandler`; `preapprove()`, the top-level init
  wrappers, and the `--policy` handler register with an explicit `[]`.
- The captured set is memoized first-write-wins in the registering
  frame's locals, keyed by the callsite's step path, deleted on pop. On
  resume the guard array is restored from JSON BEFORE replay re-runs the
  registration, so a fresh capture would see guards that did not exist
  at the original registration. Never key this by counting events —
  replay skips completed statements and iterations (`Runner.handle`
  returns before `pushHandler` for a completed block), so counters count
  different events on replay. Position or content only.
- Cost-guard suspension is STACK-scoped (`suspendedGuardIds`, consulted
  by `enforceGuards`/`chargeGuards`), not a flag on the guard object: a
  shared CostGuard flagged object-wide would blind sibling branches.
  TimeGuard suspension is object-scoped (clones are per-branch) and pins
  the clock paused across `Runner.beforeStep`'s resume-all.
- Nothing about suspension serializes. A handler that propagates gets
  checkpointed mid-suspension; the resumed run's guards must meter.
