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

Match blocks reuse `TsIfSteps`. Each match case becomes a branch with an `===` equality condition against the match expression. The default case (`_`) becomes the else branch. Since match cases have a single body statement, there's typically only one substep per branch.

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
| `lib/ir/tsIR.ts` | IR node definitions: `TsStepBlock`, `TsIfSteps`, `TsThreadSteps`, `TsWhileSteps`, `TsForSteps` |
| `lib/ir/builders.ts` | Factory functions: `ts.stepBlock()`, `ts.ifSteps()`, `ts.threadSteps()`, `ts.whileSteps()`, `ts.forSteps()` |
| `lib/ir/prettyPrint.ts` | Code generation for each IR node kind |
| `lib/backends/typescriptBuilder.ts` | `processIfElseWithSteps`, `processMessageThread`, `processWhileLoopWithSteps`, `processForLoopWithSteps`, `processMatchBlockWithSteps` |
| `lib/runtime/state/stateStack.ts` | `State.clearLocalsWithPrefix()` for loop reset |
| `lib/templates/backends/typescriptGenerator/` | Mustache templates: `substepBlock`, `ifStepsCondbranch`, `ifStepsBranchDispatch`, `threadSteps`, `whileSteps`, `forSteps` |
| `tests/agency/substeps/` | Integration tests for all block types |
