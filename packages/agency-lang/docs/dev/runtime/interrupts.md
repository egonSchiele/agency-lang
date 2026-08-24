# How interrupts resume inside blocks (substeps)

## Background

Agency uses a step-counter system to resume execution after an interrupt. The compiler gives every statement in a node or function body an integer step id, and wraps it in a `runner.step` call:

```typescript
await runner.step(0, async (runner) => {
  // statement 0
});
await runner.step(1, async (runner) => {
  // statement 1
});
```

`Runner` (`lib/runtime/runner.ts`) owns the counter. `step()` returns immediately when the counter has already passed the id, and advances the counter once the body finishes. When an interrupt fires, the counter is serialized on the frame. On resume the completed statements are skipped and execution picks up at the right statement.

That works for top-level statements. Blocks (if/else, loops, threads) were originally one step each, so an interrupt inside a block could not resume at the right statement within it.

**Substeps** solve this. Each block construct gets its own runner method, and the body statements inside it get their own nested counter.

## The step path

All substep tracking is built on a path of integers that tracks the current position in the step hierarchy. It works like a scope stack. The compiler side is `StepPathTracker` (`lib/backends/typescriptBuilder/stepPathTracker.ts`), and the runtime side is `Runner.path`.

- `processBodyAsParts` pushes the step index before processing each statement and pops after
- The block processors do the same for their body statements
- At runtime, `Runner` pushes the id before running a nested body and pops in a `finally`

The path names the frame locals that hold the tracking state. A path of `[3, 1]` gives a key of `"3.1"`, which produces locals like `__substep_3.1` and `__condbranch_3.1`. Nested blocks at different positions can therefore never collide. `Runner.getCounter()` reads `__substep_<key>` when the path is non-empty, and `frame.step` at the top level.

The joined path is also the branch key for async function calls. `forkBranchSetup` uses `this.steps.joined()` to store and retrieve branch state in `__stack.branches`.

## If/else blocks

Codegen lowers an if/else chain to a single `runner.ifElse` call. `processIfElseWithSteps` (`lib/backends/typescriptBuilder.ts`) builds the `runnerIfElse` IR node, and `lib/ir/prettyPrint.ts` prints it through `runnerIfElse.mustache`:

```typescript
await runner.ifElse(3, [
  { condition: async () => cond1, body: async (runner) => { /* then body */ } },
  { condition: async () => cond2, body: async (runner) => { /* else-if body */ } },
], async (runner) => { /* else body */ });
```

`Runner.ifElse` uses one tracking local:

- `__condbranch_<key>` — which branch was taken. It holds the branch index, or `-1` when no branch matched and there is no else.

It evaluates the conditions ONCE, in order, and caches the winning index. On resume the cached value re-dispatches to the same branch without re-evaluating anything. Statements inside the chosen branch are ordinary `runner.step` calls, so they get their own `__substep_<key>` counter under the pushed path.

Every statement inside a branch keeps its counter, so an interrupt deep inside an else-if resumes at exactly the statement it paused on.

## Match blocks

Match blocks reuse `TsIfSteps`, exactly like if/else: `processMatchBlockWithSteps` (`lib/backends/typescriptBuilder.ts`) turns each match case into a branch with an `===` equality condition against the scrutinee, and the `_` case (if present) becomes the else branch. Arm bodies are processed through `processBodyAsParts`, the same helper if/else uses, so each statement in an arm gets its own `__substep_<key>` counter — a multi-statement block arm resumes mid-arm exactly like a multi-statement if/else branch resumes mid-branch. The `__condbranch_<key>` cache means the winning arm is decided once and re-dispatched to (not re-matched) on resume, even if the scrutinee or a guard has side effects.

Code generation goes through the same `runnerIfElse.mustache` template used for if/else. There is no separate match-specific template.

### Match *expressions*

When a match is used as an expression (`const x = match(...) { ... }` or `return match(...) { ... }`), the lowered `TsIfSteps`/`runner.ifElse(...)` call additionally carries a `matchId`, and each arm's yielding `return expr` lowers to a `matchYield` node that compiles to:

```typescript
runner.exitMatch(<matchId>, <value>);
return;
```

`Runner.exitMatch(matchId, value)` (`lib/runtime/runner.ts`) does two things: it writes `value` into the frame local `__matchval_<matchId>` (so it lives in `__stack.locals`, not a bare `let`, and survives interrupt serialization), and it sets a private `_matchExit = matchId` flag. That flag is checked by `shouldSkip()` right alongside `_break`/`_continue` — while it's set, every subsequent runner construct (steps, nested `ifElse`, loop iterations) short-circuits, exactly like an in-flight `breakLoop()`. This unwinds through the rest of the arm and out to the match's own `runner.ifElse(...)` call, which is the only site that owns the id: its `finally` block clears `_matchExit` (`if (opts.matchId !== undefined && this._matchExit === opts.matchId) this._matchExit = null`), so code after the match resumes normally. An `ifElse` that doesn't own the pending id (an outer if/else or loop the match is nested in) leaves the flag set and keeps propagating.

`_matchExit`, like `_break`/`_continue`, is transient in-process unwind state and is **never serialized** — an interrupt cannot fire while a match-exit unwind is in flight, only in between statements.

The consuming statement (the `const x = ...` or `return ...` around the match) reads `__matchval_<matchId>` back out of `__stack.locals`. **No end-of-iteration reset is needed for `__matchval_<matchId>`**, unlike `__condbranch_`, `__substep_`, and `__iteration_`: the all-paths-yield check (enforced at lowering time — every code path through an expression-position arm must `return` a value) guarantees the local is freshly written before it's ever read in the same pass through the match, so a stale value from a previous loop iteration can never leak through unread. Loop-iteration resets for the other prefixes live in `loop()` and `whileLoop()` in `lib/runtime/runner.ts`, as `this.frame.clearLocalsWithPrefix(...)` calls after each iteration. No template is involved; `runnerIfElse.mustache` is the only template in match and if/else codegen.

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

Pausing at the `interrupt` serializes `__stack.step`, `__condbranch_<key> = 0` (the `success` arm), `__substep_<key> = 1`, and locals. On resume: outer guards skip completed statements; the cached condbranch re-enters the `success` arm without re-matching `r`; the substep guard skips `print`; the interrupt statement completes with the response; the `return` statement calls `runner.exitMatch(matchId, ...)`, writing `__matchval_<matchId>` and setting `_matchExit`; the owning `ifElse` call's `finally` clears the flag; the outer `const val = __matchval_<matchId>` statement reads the value. Checkpoint/`restore()` behave identically to if/else since all of this tracking lives on `__stack`.

## Thread blocks

A `thread { }` or `subthread { }` block compiles to `runner.thread(id, method, optsThunk, callback)`. `Runner.thread` creates or reopens the thread, pushes it on the active stack, runs the callback, and pops in a `finally`. The body statements inside the callback are ordinary `runner.step` calls with their own substep counter, so an interrupt inside a thread body resumes at the right statement.

`Runner.thread` remembers the thread id in the frame local `__thread_<stepPath>`. That is what makes the create idempotent: a resume re-runs the whole method, and without the local it would create a second thread.

See [threads.md](./threads.md) for what the thread machinery itself does.

## While loops

While loops are the most complex, because the body executes many times. `processWhileLoopWithSteps` emits a `runnerWhileLoop` node, which prints as:

```typescript
await runner.whileLoop(7, async () => condition, async (runner) => {
  // body statements, each its own runner.step
});
```

`Runner.whileLoop` uses two tracking locals:

- `__iteration_<key>` — which iteration we are on. It lives in `frame.locals` and survives serialization.
- `__substep_<key>` — which statement within the current iteration, maintained by the body's `runner.step` calls.

### How iteration skipping works

`currentIter` is a plain local that starts at 0 every time the loop runs, including on resume. On each turn of the loop, if `currentIter < __iteration_<key>`, that iteration already completed. The runner increments `currentIter` and `continue`s past it. When the two are equal we are at the iteration where the interrupt happened, and the substep counter guides execution to the exact statement.

### Why we re-evaluate the loop condition on skipped iterations

The condition still runs during skipped iterations. It has to: the loop variable is restored from serialized locals, and it must satisfy the condition for the loop to be entered at all. The condition is cheap, and evaluating it keeps the resume correct.

### How end-of-iteration reset works

At the end of each iteration the runner does three things:

1. Deletes every nested tracking local under this loop's path prefix
2. Sets `__iteration_<key>` to the next iteration number
3. Advances `currentIter`

**The reset is critical for correctness.** Without it, tracking locals from a previous iteration would persist into the next one. A `__condbranch_` value cached in iteration 0, where `x == 0`, would stop the condition being re-evaluated in iteration 3, where `x == 3`.

`clearLocalsWithPrefix` is a method on the `State` class in `lib/runtime/state/stateStack.ts`. It walks every key in `frame.locals` and deletes those starting with the given prefix. `loop()` and `whileLoop()` clear five prefixes:

- `__substep_<path>` — substep counters from nested blocks
- `__condbranch_<path>` — cached branch decisions from if/else and match blocks
- `__iteration_<path>` — iteration counters from nested loops
- `__interruptId_<path>` — persisted interrupt ids from nested interrupt sites
- `__pipe_result_` — pipe-chain intermediates

The prefix approach is deliberately broad. Enumerating specific keys would be fragile and would break whenever a new kind of tracking local appears.

**If you add a new kind of tracking local**, you must either name it with one of the existing prefixes, so the sweep already covers it, or add a `clearLocalsWithPrefix` call for the new prefix to both `loop()` and `whileLoop()` in `lib/runtime/runner.ts`. Skip that and the local persists across iterations, and resume after an interrupt goes wrong.

## For loops

For loops go through `Runner.loop(id, items, callback)`. The runtime, not codegen, owns the iteration: `loop()` classifies the value with `classifyIterable` (`lib/utils/iteration.ts`), which is shared with `_pairsOf`, so comprehensions and `for` loops can never disagree about what is iterable. Arrays iterate by element, records by key, and anything else iterates zero times.

`processForLoopWithSteps` handles the surface forms:

- **Range:** `for (i in range(5))` becomes an `Array.from({length: ...}, ...)` expression passed as `items`
- **Indexed:** `for (item, idx in items)` passes `indexVar`, and the callback's second argument is the array index or, for a record, the value at the current key
- **Basic for-each:** `for (item in items)` passes the iterable straight through

The iterable is emitted as a thunk (`async () => <expr>`). A `return` earlier in the function halts the runner and skips the steps that assign the locals the expression reads, so evaluating it eagerly would dereference an unset local.

For arrays the runner re-reads `.length` each turn rather than snapshotting, so a body that appends to the array it is iterating keeps going. `tests/agency/for-loop-live-iteration.agency` pins that.

Iteration skipping, substep counters, and the end-of-iteration reset all work exactly as in while loops.

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

`respondToInterrupts` takes an optional `overrides` option that lets you change local variables in the execution state before resuming.

That is useful when you want to both answer the interrupt and correct a value computed earlier in the run.

### API

A compiled module exports `respondToInterrupts` along with the two response constructors, `approve(value?)` and `reject(value?)`:

```ts
respondToInterrupts(interrupts, [approve()], { overrides: { mood: "happy" } });
respondToInterrupts(interrupts, [reject()], { overrides: { retryCount: 0 } });
respondToInterrupts(interrupts, [approve(resolvedValue)], { overrides: { mood: "happy" } });
```

The responses array is positional: one response per interrupt in the array you were handed.

### What you can override

`overrides` is a `Record<string, unknown>`. It sets values in the locals of the stack frame where the interrupt occurred, so you can override any local that exists at that point.

### Example

```agency
node main(message: string) {
  const mood: "happy" | "sad" = llm("Categorize: ${message}")
  const result = interrupt("Confirm mood: ${mood}")
  const response: string = llm("Respond to ${mood} user")
  return { mood, response }
}
```

From TypeScript:

```ts
import { main, respondToInterrupts, approve, isInterrupt } from "./agent.js";

const result = await main("I feel fine");

if (isInterrupt(result.data)) {
  // The LLM said "sad" but we want to correct it to "happy" AND approve
  const fixed = await respondToInterrupts(result.data, [approve()], {
    overrides: { mood: "happy" },
  });
  console.log(fixed.data.mood); // "happy"
}
```

The override is applied to the checkpoint state before execution resumes, so the later LLM call sees `mood = "happy"`.

### Implementation

`applyOverrides` lives in `lib/runtime/rewind.ts`. `respondToInterruptsCore` in `lib/runtime/interrupts.ts` calls it after fetching the checkpoint and before creating the resumed execution context.

## Key files

| File | Role |
|------|------|
| `lib/ir/tsIR.ts` | IR node definitions (`TsRunnerStep`, `TsRunnerIfElse`, `TsRunnerLoop`, `TsRunnerWhileLoop`, `TsRunnerThread`) |
| `lib/ir/builders.ts` | Factory functions for IR nodes |
| `lib/ir/prettyPrint.ts` | Code generation for each IR node kind |
| `lib/runtime/runner.ts` | `Runner` — step counters, `ifElse`, `loop`, `whileLoop`, `thread`, `hook`, `handle` |
| `lib/backends/typescriptBuilder.ts` | `processIfElseWithSteps`, `processMessageThread`, `processWhileLoopWithSteps`, `processForLoopWithSteps`, `processMatchBlockWithSteps` |
| `lib/backends/typescriptBuilder/stepPathTracker.ts` | `StepPathTracker` — the compile-time step path |
| `lib/runtime/state/stateStack.ts` | `State.clearLocalsWithPrefix()` for loop reset |
| `lib/templates/backends/typescriptGenerator/runnerIfElse.mustache` | The one template in if/else and match codegen |
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
NOT in that set (`StateStack.beginSuspension`), so the handler's own
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

## Guard trips as interrupts (resumable guards, PR 2)

A cost-guard trip raises an ordinary interrupt (effect `std::guard`)
instead of throwing. The pieces, and where they live:

- **Detection and raising:** `runPrompt` runs an idempotent guard-gate
  step (`pr.step("guardGate.*")`) before every request step and once
  before returning. The gate runs `raiseGuardTripsUntilClear`
  (`lib/runtime/guardTripInterrupt.ts`), which loops on
  `stack.detectTrippedGuard()` and raises one interrupt per trip.
  It loops because one answered question does not clear the gate:
  approving an inner guard can leave an outer one over its own limit,
  and each budget is owed its own question. The gate lives at the
  pr.step level — NOT inside `_runPrompt` — because a raise inside a
  non-idempotent llm-call step body breaks replay (the body would
  re-push its user message on resume). The old in-`_runPrompt` pre-call
  check remains as a throwing backstop; the post-charge check is gone
  (its trips raise at the next gate, and nothing paid runs in between).
- **The scope:** `GuardScope` (`lib/runtime/guardScope.ts`) is the
  runtime name for what one Agency `guard(...)` call pushed — up to two
  runtime guards, two ids. The interrupt carries `scopeIds`; approve
  resolves the scope ON THE RAISING BRANCH'S STACK and applies the
  merged payload via `scope.extend` (additive; negative grants clamp to
  zero with a warning; `disarm` is explicit; a root-budget scope
  refuses; an answer leaving the tripped dimension over budget and
  armed is a runtime error — it would re-trip forever).
- **Resume idempotency:** the trip's persisted interrupt id lives in
  `stack.other` under a key DERIVED from guard state
  (`__guardTrip_<scopeIds>#<dimension>@<limit>`) — stable across
  replays of one trip, necessarily fresh for the next (an approve
  strictly raises the limit; disarm ends the dimension). Never count
  events for such keys: replay skips completed work.
- **Fork dedupe (cost only, by construction):** the shared `CostGuard`
  object carries a live `pendingTrip` record. A sibling branch that
  detects the same guard over budget parks on it, then re-detects.
  Set before the first await (mutual exclusion), settled in the
  `finally` on every exit (a missed settle would hang the fork join).
  Time clones are per-branch objects — nothing to dedupe.
- **What still throws:** root budgets (`isRootBudget`, serialized),
  the parent-side subprocess telemetry site (`ipc.ts` — an IPC message
  callback has no runner to raise from; documented v1 limit), and
  `addCost` (raising from arbitrary TS-helper contexts inside
  non-idempotent step bodies has the same replay hazard as raising
  inside `_runPrompt`).
- **Rejecting** delivers the original `GuardExceededError` at the gate;
  everything downstream — `AbortedResult`, the level rule, `finalize`,
  the guard boundary's conversion — is untouched.

## The guard construct (guard keyword)

`guard(...) { }` is a language construct that desugars, in the
preprocessor AND at the TypeChecker entry, to the exact
`functionCall` + `blockArgument` shape the old stdlib-function syntax
parsed to — calling `_guard` (stdlib/index.agency, on the auto-import
prelude). Nothing at this layer changed: the same gates, raise
surfaces, trip keys, and frames run under the construct. `_guard`'s
`std::guard` effect is seeded at its symbol
(`TS_SIDE_EFFECT_SEEDS`, lib/symbolTable.ts) because its trips are
raised by this runtime machinery, invisible to the interrupt-statement
walk. See docs/superpowers/specs/2026-07-17-guard-keyword-design.md.

## Time trips (resumable guards, PR 3)

Time budgets burn between paid actions, so the gates alone cannot catch
them. PR 3 adds two raise surfaces and the join rule:

- **The derived abort signal:** `stack.abortSignal` is now an accessor.
  The setter stores the BASE signal (user cancel, race loser);
  `rebuildAbortSignal()` composes base + every installed guard's
  `armedSignal()` via `AbortSignal.any`. Push, pop, suspension
  brackets, and `GuardScope.extend` all recompose — re-arming an
  approved guard is a rebuild, not a save/restore chain (the old
  `previousSignal` field is gone).
- **Step-boundary raise:** `Runner.step` AND `Runner.hook` (loop bodies
  compile to hook) probe `stack.firstRaisableTrip()` before
  `shouldSkip`'s consuming walk, and call `raiseGuardTripsAtStep`
  (`lib/runtime/guardTripInterrupt.ts`) when it fires. That helper loops
  on `stack.detectStepRaisableTrip()`, the non-consuming sibling of the
  gate's detector. Then: approve applies
  and the step body runs; reject throws exactly what shouldSkip would
  have thrown; unanswered checkpoints AT THIS STEP and halts —
  replay-safe because the resumed boundary re-detects and applies the
  recorded answer before the body runs. The probe is
  `Guard.raisableTripAtStep()`: cost guards always decline (cost only
  ripens at paid actions, which sit behind the gates; raising it at
  arbitrary steps would re-ask settled questions and deliver a reject
  outside the owning boundary), and time guards decline once suspended,
  consumed, or leaf-delivered. The raise also fires inside tool bodies
  (taxonomy case b): it rides the same in-tool interrupt path as an
  input() inside a tool, so on approve the tool continues where it
  paused and its result reaches the thread — never a dangling
  tool_use.
- **`TimeGuard.check()` reads the clock**, not just the timer latch: a
  tight Agency loop is an unbroken microtask chain that starves the
  setTimeout macrotask, so busy loops used to escape time guards
  entirely. The timer stays as the eager notifier that cancels
  in-flight leaf ops.
- **Mid-request cancellation is resumable:** when a non-root time trip
  aborts an in-flight LLM request, `_runPrompt` recognizes the
  `guardTrip` cause and throws `GuardTripRetry`;
  `requestStepWithTripRetry` catches it, runs a gate
  (`<key>.retryGate.N`), and re-issues the request from the same thread
  state. The prompt push is its own idempotent `pushPrompt` step so
  re-issue never duplicates the user message.
- **Settling at the block boundary:** when `_runGuarded` exits, the
  Result is guard()'s answer; `stack.settleGuards(ids)` suspends the
  owned guards for the one remaining step before `_popGuard`. Without
  it, a clock crossing its limit after the work concluded would raise a
  question about nothing, and a late timer fire could flip a computed
  success into a failure.
## The feedback channel (resumable guards, PR 4)

`approve({message})` delivers reviewer feedback to the model. Two
halves:

- **Queueing:** `applyVerdict` (guardTripInterrupt.ts) pushes the
  merged message (effectMerge newline-joins multiple handlers') onto
  the raising branch's `stack.other.__guardFeedback` via
  `StateStack.queueGuardFeedback` — branch-local (each fork branch has
  its own stack) and serialized (an approve applied just before a
  checkpoint keeps its message). The entry carries its label,
  `guard:<label>` (the guard's `label:`, falling back to the
  dimension). Queued after `scope.extend` so a defective answer
  (GuardApproveError) never leaves a message behind. Feedback queued in
  a fork branch that makes no further request dies with the branch at
  the join — same lifetime as the branch's reply-attachment queue.
- **Draining:** the turn-boundary machinery (`lib/runtime/turnBoundary.ts`,
  `guardFeedbackProducer`) drains the queue in an idempotent step of
  its own right before each request step — `guardFeedback.initial`,
  `round.N.guardFeedback`, `validation.N.guardFeedback`, and
  `<key>.retryFeedback.N` inside the trip-retry wrapper (a mid-request
  approve's message belongs in the re-issued request). `prompt.ts`
  reaches those steps through `runInitialBoundary`,
  `runRoundBoundary`, and `runGateAndFeedback`. Everything
  queued drains as ONE user-role thread message, entries
  newline-joined oldest first — providers like Anthropic want
  user/assistant alternation, so a drain must not emit a run of
  consecutive user messages. The label lists each contributing guard
  once (`guard:a,guard:b`), pushed via
  `MessageThread.push(message, label)` (#557) — labels are
  observability-only and never reach the provider. A message queued
  outside any LLM loop (a step-boundary approve in plain code) waits
  and lands at the branch's next `llm()` call's initial drain.

Cross-process: the approve payload rides the interrupt IPC verbatim, so
a PARENT's `approve({message})` for a CHILD's forwarded trip queues and
injects inside the child
(tests/agency/subprocess/trip-forward-approve-message).

A note for the future: `message` is a payload key the runtime
INTERPRETS — it has channel semantics the way `maxCost` has grant
semantics — but nothing declares that. Today a key of an approve
payload either does something magical (guardTripInterrupt.ts applies
it) or silently nothing. When approve payloads become typed per effect
(#555), how each key gets USED should be declared alongside its shape,
so a payload's behavior is inspectable instead of buried in the
runtime.

- **The join rule (decision 15, "the grant follows the budget"):**
  `TimeGuard.extendBudget` records its clamped grant in a serialized
  `grantedMs`; `cloneForBranch` deliberately does NOT copy it (it means
  "granted during this branch"). At a batch join,
  `chargeAndResumeParentTimeGuards` extends the parent by the grant of
  the SAME branches whose time it charges — the charged branch in "max"
  mode, every branch in "sum" mode — before `addElapsed`, so an
  approved branch cannot trip the parent at the join. The extension
  goes through `extendBudget`, so it records into the parent's own
  `grantedMs` and propagates up nested joins one at a time. Grants
  never cross budgets (decision 16): only clones sharing the parent's
  guardId are read.

## No pause inside handlers (issue #616)

Handler functions compile to plain callbacks with no step counters, so
there is no step address inside a handler for a resume to replay back
to. That makes one rule absolute: an interrupt-pause checkpoint must
never capture a moment when a handler is mid-flight, because that
checkpoint could never be resumed. The enforcement has two carriers.
`StateStack.executingHandlerEntries` is the loss-proof one: the
dispatcher mirrors each executing handler entry onto the raising
branch's stack, branch stacks inherit a snapshot of it through
`runBatch`, and the guard-trip machinery refuses to surface (it throws
the original trip error instead) while the list is non-empty. Every
interrupt-pause checkpoint site calls
`stack.assertNoExecutingHandlers()`, which walks the branch subtree and
fails loudly if the impossible happens. The `executingHandlers.ts`
AsyncLocalStorage remains, but only for what the stack cannot express:
per-lineage precision, so self-exclusion and the `renderVerdict`
refusal can tell a handler's OWN raises apart from concurrent sibling
dispatches on the same branch. The design rationale lives in
`docs/superpowers/specs/2026-07-19-issue-616-no-pause-inside-handlers-design.md`.

## Replay and helper calls: the hoistCalls pass

Resume replay re-runs the statement that was in progress at the pause.
Before 2026-07, that replay also re-executed helper calls inside that
statement which had already completed — `llm(msg, llmOptions(...))`
re-ran `llmOptions()` — and each re-run consumed a saved frame from the
positional restore queue that belonged to a still-live function. The
`hoistCalls` preprocessor pass (docs/dev/compiler/hoist-calls.md) rewrites every
such helper into its own `const __hoist_N = ...` statement, so on
resume the helper's completed step is skipped and its value read back
from the frame instead of recomputed. As a backstop, frames are stamped
with their owner's scope name at claim time, and a mismatched claim on
replay throws a "Resume desync" error instead of silently corrupting
state.
