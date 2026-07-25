# Issue 616: No Pause Inside Handlers — Implementation Plan

> **For agentic workers:** Execute this plan inline in the main session using superpowers:executing-plans (owner preference: no subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for a guard trip raised inside a handler function to pause the run.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-19-issue-616-no-pause-inside-handlers-design.md`

**Issue:** https://github.com/egonSchiele/agency-lang/issues/616

This plan is written so that you can execute it without having read anything else first. Part 1 explains how the relevant runtime code works today. Part 2 explains what we are changing and why each piece is needed. Part 3 lists the working rules for this repo. The tasks follow. If you only read one part before starting, read Part 2 — but read Part 1 the moment anything surprises you, because every design decision below traces back to a fact in it.

---

## Part 1: Background — how the runtime works today

### How Agency pauses and resumes

Agency can pause a running program, hand a snapshot to the user, and resume later — even in a different process, days later. The snapshot is called a **checkpoint**. This works because compiled Agency code is not free-form JavaScript. Every statement is wrapped in a numbered step:

```js
await runner.step(1, async (runner2) => {
  __stack.locals.count = 0;
});
```

The `runner` here is an instance of the `Runner` class from `lib/runtime/runner.ts`. It is the engine that executes a compiled function or node step by step. Because every step has a number, every position in the program has an address, like `main:2.0` meaning "node main, step 2, sub-step 0". When a run pauses, the checkpoint records the address. When the run resumes, the runner replays the whole step skeleton from the top, skips every step that already completed, and re-enters the exact step it left.

The consequence that drives this entire plan: **a place in the program can only pause if replay can find its way back there.** No step address means no way back, which means pausing there produces a checkpoint that can never be resumed.

### Handlers have no step address

A handler is the `with (data) { ... }` part of a `handle` block. It is the code that decides whether to approve or reject an interrupt. Here is what a `handle` block compiles to:

```js
await runner.handle(1,
  async (data) => {            // the HANDLER: a plain callback. No runner. No steps.
    ...
    return await approve();
  },
  async (runner2) => {         // the BODY: numbered steps, as usual.
    await runner2.step(0, ...)
    await runner2.step(1, ...)
  });
```

The handle *body* gets steps. The *handler* does not. The interrupt dispatcher calls the handler directly as a function; "call the handler" was never a step. So if the run somehow paused while a handler was mid-flight, the checkpoint would be garbage: replay has no road that re-enters the handler. This is a hard architectural fact, confirmed by the owner. **Pausing inside a handler is impossible, and nothing in this plan may try to make it possible.** Every fix below refuses the pause; none of them tries to make it resumable.

### But code inside a handler still runs on runners

Here is the subtlety that makes the bug possible. The handler callback itself has no steps, but everything it *calls* does. A handler that runs a guard block, or calls a function, executes compiled functions that each create their own `Runner` with their own numbered steps. Those steps run normally. They have one special property: they are unreachable by replay, because the only road to them passes through the handler dispatch, which has no step address.

So the runtime contains a class of steps that must never become pause points. Today, nothing marks them.

### Guard trips, and where they are raised

A **guard** is a budget wrapper: `guard(time: 5ms) { ... }` runs the block and trips if it exceeds 5 milliseconds of wall-clock time. A **trip** is what happens when the budget is exceeded. A trip is not an immediate error. It becomes an interrupt with the effect name `std::guard`, and the handler chain gets to decide: approve with more budget, or reject, which fails the guard block.

Time trips become detectable at arbitrary step boundaries, because the clock runs between steps. So `Runner.step` checks for trips at *every step entry* (`lib/runtime/runner.ts:508`, and again for hook steps at :557). The checking function is `maybeRaiseGuardTrip` (runner.ts:361). When it finds an over-budget guard, it calls `raiseGuardTripsAtStep` in `lib/runtime/guardTripInterrupt.ts` (:298), which runs the handler chain for the trip. Three outcomes:

- **Approved** — budget extended, execution continues into the step.
- **Rejected** — the original `GuardExceededError` is thrown. The guard block fails. Everything downstream of a failed guard (draft salvage, the conversion to a `failure` Result) already handles this; it is a normal, first-class outcome.
- **Unanswered** — nobody approved or rejected. Then `raiseGuardTripsAtStep` does the pause: it creates a checkpoint, persists the open question, and halts the runner so the interrupt surfaces to the user.

That third branch is the forbidden move when the step belongs to code running inside a handler. There is also a second raising site with the same shape: `runPrompt` runs the same machinery (`raiseGuardTripsUntilClear` → `raiseOneTrip`) as a gate before each LLM request, so an `llm()` call inside a handler has the same exposure.

### The two defenses that exist today, and the one fact they share

Two mechanisms currently stand between the guard gate and a forbidden pause.

**Defense 1: self-exclusion.** A handler never hears its own raises. When a guard trips inside a handler, the dispatcher (`runHandlerChain` in `lib/runtime/interrupts.ts`, skip at :268) skips the handler that is currently executing, and the rest of the chain decides. In the CI test that found this bug, the outer handler in `main` approves every trip, so the trip is answered and the unanswered branch never runs.

**Defense 2: the refusal.** If nothing answers, the verdict-rendering function `renderVerdict` (interrupts.ts:436) checks `insideHandlerFunction()` at :479 and converts the unanswered outcome into a rejection with an explanatory message. A rejection throws; nothing pauses. This was the PR #611 fix for ordinary interrupts raised inside handlers, and guard trips flow through it too.

Both defenses ask the same question — "is a handler executing right now, and which one?" — and both read the answer from the same place: an `AsyncLocalStorage` in `lib/runtime/executingHandlers.ts`. `AsyncLocalStorage` (ALS for short) is a Node.js feature that carries a value down through a chain of async calls invisibly, like a thread-local variable. `runAsHandler` pushes the handler's entry onto the ALS for the duration of the handler body; `executingHandlers()` and `insideHandlerFunction()` read it.

That is the true shape of issue #616: **the no-pause-in-handler rule is not enforced at the pause site by anything structural. It is enforced by an ambient ALS read, and both layers of defense share that single point of failure.**

### What the CI failure looked like

The test `tests/agency/handlers/handler-guard-trip.agency` failed once in CI and once locally with this output:

```
- "work done|trips:1"
+ "work done|trips:9"
HandlerRecursionError: ... nested 10 levels deep ...
    at raiseOneTrip (guardTripInterrupt.js)
```

`trips:9` means the outer handler answered nine trips instead of one. The recursion entering through `raiseOneTrip` means self-exclusion missed on the forward path: the inner handler heard its own trip, re-entered its own guard block, created a fresh 5ms guard, tripped again, and looped until the depth-10 backstop threw. The investigation (`docs/superpowers/specs/2026-07-19-handler-guard-trip-recursion-investigation.md`) could not force a repro — the trigger is scheduling jitter on a loaded machine, and instrumentation hides it — but every piece of evidence is consistent with the ALS read coming up empty while the handler was executing. And when that read comes up empty, *both* defenses vanish at once, because they read the same thing. Neither fails loudly. They just answer "no handler here" and step aside.

### The bypass that needs no ALS failure at all

One path skips defense 2 even with a perfectly healthy ALS. `raiseOneTrip` (guardTripInterrupt.ts:78) begins with a resume branch (:91):

```ts
// Resume path FIRST: an answered question must never re-ask.
const persistedId = stack.other[key] as string | undefined;
if (persistedId !== undefined) {
  const recorded = ctx.getInterruptResponse(persistedId);
  if (recorded) { ...apply the recorded answer, done... }
  // The question is already OPEN ... Re-surface the SAME interrupt id
  // rather than re-running the chain and minting a fresh one
  return [interrupt({ ..., interruptId: persistedId })];
}
```

This branch exists for a good reason: when a paused run resumes, the replayed gate must re-find its open question instead of asking the user twice. But look at what the open-question path does: it returns the interrupt **directly**, without running the handler chain, and therefore without ever reaching `renderVerdict` and its refusal. The persisted question id lives in `stack.other`, which is part of the serialized state, so this branch stays armed across every pause and resume. One bad surface from inside a handler persists an id; every later replay then re-surfaces it with no refusal check at all. One bad pause poisons all future resumes.

### Facts about the state model you need before touching it

**The `StateStack` and its frames.** `StateStack` (`lib/runtime/state/stateStack.ts:342`) is the per-branch record of where execution is: a `stack` array of `State` frames (one per active function call), plus assorted per-branch state like `other` (a grab-bag of persisted keys, including the guard-trip question ids) and the guard list. Every `Runner` holds its `StateStack` as a plain object field (`this.stack`), and the dispatcher receives it as an explicit parameter. Nothing about reaching a `StateStack` involves the ALS.

**Branches hang off frames, not off the stack.** This surprised us during design, so it gets its own paragraph. When Agency runs concurrent work — a `fork`, a `race`, or parallel tool calls inside an `llm()` — each concurrent arm gets its own fresh `StateStack`, called a **branch stack**. Branch stacks are stored on the *frame* that created them: `State.newBranch` (stateStack.ts:134, on class `State`, not on `StateStack`) does `{ stack: new StateStack() }` and stores it in `frame.branches[key]`. Two consequences. First, a fresh branch stack inherits *nothing* from its parent — any mark we put on the parent must be copied over explicitly. Second, any check that claims "no handler is executing anywhere under this stack" must walk frames, then each frame's branches, recursively.

**All branch execution goes through one primitive.** `runBatch` (`lib/runtime/runBatch.ts`) is the single runtime function that owns concurrent execution. Its four callers are fork, race, parallel tool calls, and the subprocess path (`docs/dev/runBatch.md`). Every mode awaits its children before returning: mode `"all"` uses `Promise.allSettled`, mode `"race"` uses `Promise.race` and aborts the losers, deleting their branches. There is no detached mode. This gives us a liveness guarantee we rely on: **a branch created while a handler executes has finished (or been aborted) before that handler body returns.** `runBatch` also has an internal helper, `rehydrateInheritedGuards` (:317), which it calls at every branch start and again on resume, to re-establish parent-derived state (shared guard references) on the branch stack. That helper is the established home for "copy parent facts into a branch," and we will extend it.

**Handlers run on the raiser's stack.** When branch A raises and branch B's handler runs for it, the handler executes on A's async lineage and A's stack. We verified this during the #611 work: the handler's counter writes land in the raising branch's state. So marking "a handler is executing" on the stack the raise arrived on marks exactly the right scope, and sibling branches keep their own unmarked stacks, which is the isolation we want.

**Async calls and the pending-promise store.** Agency supports `async foo()`, which starts `foo` without awaiting it. The promise is registered in `ctx.pendingPromises`, an instance of `PendingPromiseStore` (`lib/runtime/state/pendingPromiseStore.ts`). Registered promises are awaited at *boundaries*: before the variable is first used, before an interrupt serializes state, before returning to TypeScript (`docs/dev/async.md`). Keys are minted from a counter: `` `__pending_${counter++}` ``. Two facts matter for us. First, async calls do **not** create branch stacks — they push ordinary frames on the caller's stack — so the branch-copy logic does not apply to them. Second, a handler body is not currently a boundary, so an async call launched inside a handler can still be running after the handler returns. That is a hole we must plug, and Part 2 explains how.

**Not every checkpoint is a pause.** This discovery reshaped the design late, so do not skip it. Guard scopes create *pinned* checkpoints at scope entry as part of the resumable-guards machinery (`lib/runtime/resumableScope.ts:125`). Guard blocks legitimately run inside handlers — that is the entire "supervise" pattern this test models. So checkpoints *are* created inside handlers today, on healthy paths. The forbidden thing is narrower: an **interrupt-pause** checkpoint, the kind where the run exits and hands control to the user. There are exactly four sites that create those: `raiseGuardTripsAtStep` (guardTripInterrupt.ts:322), the TS-raise surface path (`agencyInterrupt.ts:189`), the prompt-step bailout (`promptRunner.ts:112`), and the shared batch checkpoint for paused fork children (`runBatch.ts:529`). Our assertion goes at those four sites and nowhere else. Putting it inside `CheckpointStore.create` would fire on the healthy pinned-checkpoint path and break supervise.

---

## Part 2: What we are building, and why each piece is needed

The fix has three layers. Here they are in plain words, with the reasoning that produced each one.

### Layer 1: the guard-trip machinery refuses to pause inside a handler

This closes the confirmed bug. When a guard trip is raised while a handler is executing and nobody answers it, the runtime must treat it as rejected: throw the original `GuardExceededError` instead of checkpointing and halting. Rejection is already a first-class trip outcome, so the guard block fails exactly the way it fails when a handler explicitly rejects, and the handler carries on with a failed guard Result. Concretely, in the shape of the failing test:

```ts
} with (data) {
  const guarded = guard(time: 5ms) { ... }
  // If nobody answered the trip, `guarded` is a failure. The handler
  // keeps running. The run never paused.
  if (isFailure(guarded)) { ... }
  return approve()
}
```

The refusal must land in three places, because there are three doors:

1. **The unanswered-dispatch door.** `renderVerdict` already refuses here when it can see the mark. After layer 2, its read is reliable. We add a redundant check in `raiseOneTrip` right before it would persist the question id — reaching that line inside a handler means a pause was about to be recorded into serialized state, and that must fail loudly rather than poison resumes.
2. **The persisted-id door.** The resume branch at the top of `raiseOneTrip` re-surfaces an open question without consulting anything. It gets an explicit check: inside a handler, throw the trip error instead of re-surfacing. Applying a *recorded answer* stays untouched — that path resolves in place and pauses nothing.
3. **The checkpoint door.** `raiseGuardTripsAtStep` asserts no handler is executing immediately before it creates its checkpoint. With doors 1 and 2 closed this is unreachable, which is exactly why it should exist: the lesson of this bug is that "unreachable" claims need enforcement.

### Layer 2: the "a handler is executing" fact moves to the StateStack

Layer 1 only works if the question "am I inside a handler?" answers correctly. Today the answer lives in an ALS, and the best explanation of the CI failure is that the ALS read came up empty under load. You cannot fix that by adding more checks that read the same ALS — an assertion reading an unreliable source inherits the unreliability and never fires exactly when it matters.

So the executing-handler list moves onto `StateStack`, as a new field. Why the stack is the right carrier:

- **Every reader already holds it as a plain object.** The runner has `this.stack`. The dispatcher has its `stack` parameter. The guard-trip machinery has its `stack` parameter. No ambient lookup anywhere in the read path, so there is nothing to lose.
- **The writer has it too.** `runHandlerChain` receives the stack explicitly, so it can push the entry before the handler body runs and pop it in a `finally`, with no ALS involved.
- **Fork isolation falls out for free.** Handlers run on the raiser's stack (Part 1), so marking that stack marks exactly the raise's scope, and sibling branches on their own stacks are unaffected — which is the behavior the old ALS comment demanded ("a handler executing in one branch must still hear raises from another").
- **It is consolidation, not invention.** `StateStack` already owns this genre of per-branch execution fact: the persisted trip ids in `other`, guard suspension state, the branches themselves.

The list stores `HandlerEntry` objects — the `{ fn, liveGuardIds }` records from `lib/runtime/types.ts:63` that the dispatcher already uses — not a boolean, because self-exclusion needs to know *which* entries are executing, and identity is by object reference. With the list on the stack, the ALS module (`executingHandlers.ts`) has no remaining purpose and is deleted. Its only importer is `interrupts.ts` (verified by grep), so the deletion touches one file.

Two mandatory follow-through pieces, each closing a hole the move would otherwise open:

**Branch stacks must inherit the mark.** `newBranch` creates a fresh, empty `StateStack` (Part 1). A handler that calls `llm()` with tools, or forks, would run those arms on unmarked stacks, and a trip inside such an arm could pause. The copy goes in `runBatch`'s `rehydrateInheritedGuards` helper, which already runs at every branch start for all four callers and already exists to copy parent-derived state into branches. It is a snapshot copy, not a shared reference, because the parent pops its entries on handler exit and the branch must not observe that mid-flight. The snapshot is safe because branches never outlive the handler that was running at their creation — the `runBatch` liveness guarantee from Part 1. (`newBranch` itself cannot do the copy: it is a method on `State`, which has no reference to the `StateStack` that owns it.)

**Handler exit must await the handler's own async calls.** An `async foo()` launched inside a handler can outlive the handler body (Part 1). After the pop, its remaining steps would gate against an unmarked stack — same hazard, new door. So handler exit becomes an await boundary, but a *scoped* one. The dispatcher records the position of `ctx.pendingPromises`' counter when it pushes the entry — call this the **watermark** (a name this plan invents) — and in its `finally`, *before popping the entry*, awaits only the promises registered after the watermark. Ordering matters: the straggler finishes while the stack is still marked, so a trip inside it refuses correctly.

Why scoped and not simply `awaitAll()`? Because a blanket await deadlocks. Walk through it: the handle *body* runs `x = async foo()`; `foo` raises an interrupt; the chain dispatches; a handler runs; that handler's exit calls `awaitAll()`, which awaits `foo`'s promise — but `foo` is blocked inside `interruptWithHandlers`, waiting for this very chain to return. Deadlock. The watermark excludes `foo` by construction: it was registered before the handler began, so it is someone else's to await. Promises started *inside* the handler cannot be blocked on the handler's own return, because raises dispatch eagerly at the raise site and always settle there — approve, reject, or the in-handler refusal, never an unsettled wait.

### Layer 3: the four interrupt-pause sites assert the mark is empty

The loud backstop. Each of the four sites that create an interrupt-pause checkpoint calls a new method, `stack.assertNoExecutingHandlers()` (a name this plan invents), immediately before creating it. The method throws a descriptive error if any handler is executing on the stack *or on any branch stack underneath it* — it must walk frames and their branches recursively, because a mark can live on a tool-call branch whose parent stack is unmarked. With layers 1 and 2 in place, all four calls are unreachable. That is the point: the old design's comment said "a checkpoint can never observe this" and was wrong silently. The new design says it and checks it, so being wrong becomes an immediate test failure with a clear message instead of a latent resume-poisoner.

User-called `checkpoint()` is deliberately *not* asserted. That is spec open question 1, resolved narrow: in-handler checkpoint creation has legitimate uses today (the pinned resumable-scope checkpoints from Part 1), and only the pause kind is forbidden.

### What stays untouched, so you do not "fix" it

- **`handlerChainDepthALS`** in interrupts.ts, the depth-10 recursion backstop. It is also an ALS, and yes, it shares the hypothesized failure mode — the spec names this tension. It stays: once the runaway cannot start, the backstop's own reliability is no longer load-bearing, and chain-dispatch depth is a genuinely lineage-shaped fact.
- **The recorded-answer path** in `raiseOneTrip` (:94-98). A trip that surfaced legitimately, got answered, and is being replayed applies its answer in place. Pauses nothing. Untouched.
- **The `pendingTrip` cross-branch dedupe** in `raiseGuardTripsUntilClear`. Unrelated machinery; the comments in that file explicitly warn against "fixing" it.
- **The debugger's behavior inside handlers.** Already handled: handler execution is wrapped in `ctx.enterToolCall()`, and the debug hook skips inside tool-call windows.
- **The `handler-guard-trip` test's wall-clock flakiness.** That is issue #575 (fake clock), a separate change. The tests added in Task 6 here are the ones that pin #616; a green #575 must not close it.

---

## Part 3: Working rules for this repo

- **NEVER commit on `main`.** Task 0 creates the branch. Run `git branch --show-current` before every commit and check the output.
- Build with `make`, not `pnpm run build` — the latter skips `lib/agents`, and agency tests execute against `dist/`, so a stale build makes test results lie.
- Save every test run's output to a file (the commands below all redirect to `/tmp/616-*.log`). The tests are slow and expensive to rerun; examine the log instead of rerunning.
- Do NOT run the full agency test suite locally. Run only the specific tests named in each task. CI runs the rest on the PR.
- Agency execution tests run via `pnpm run agency test <file>`. Unit tests run via `pnpm test:run <file>` (vitest, single pass).
- No narrating comments. A comment states a constraint the code cannot express. It never restates the next line, and it never argues that the change is correct.
- Commit messages must not contain apostrophes — the shell mangles them. The messages below are written apostrophe-free; keep them that way.
- Before the PR: audit the full diff against `packages/agency-lang/docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md`.
- All relative paths below are relative to `/Users/adityabhargava/agency-lang/packages/agency-lang/`.

## Part 4: File map

| File | What it is | What changes |
|---|---|---|
| `lib/runtime/state/stateStack.ts` | Per-branch execution state | New `executingHandlerEntries` field, `adoptExecutingHandlersFrom`, `assertNoExecutingHandlers` |
| `lib/runtime/state/pendingPromiseStore.ts` | Registry of unawaited async-call promises | New `watermark()` and `keysSince()` |
| `lib/runtime/interrupts.ts` | Interrupt dispatch: the chain walk and verdict rendering | Carrier swap, no-stack throw, watermark await at handler exit, `renderVerdict` reads the stack |
| `lib/runtime/executingHandlers.ts` | The ALS this whole plan retires | **Deleted** |
| `lib/runtime/guardTripInterrupt.ts` | Guard trips as resumable interrupts | The three refusal doors from layer 1 |
| `lib/runtime/runBatch.ts` | The one primitive for concurrent branches | Mark adoption in `rehydrateInheritedGuards`; pause-site assertion |
| `lib/runtime/agencyInterrupt.ts` | TS-raised interrupts surfacing | Pause-site assertion |
| `lib/runtime/promptRunner.ts` | Prompt-step bailout machinery | Pause-site assertion |
| `docs/site/guide/handlers.md`, `docs/dev/interrupts.md`, `docs/dev/checkpointing.md` | User and dev docs | The new invariant, stated |
| `tests/agency/handlers/handler-guard-trip-propagate.*`, `-unhandled.*` | New fixtures | The refusal path, pinned |

New unit test files: `lib/runtime/state/stateStack.executingHandlers.test.ts`, `lib/runtime/state/pendingPromiseStore.test.ts`, `lib/runtime/interrupts.executingHandlers.test.ts`, `lib/runtime/guardTripInterrupt.inHandler.test.ts`.

---

### Task 0: Branch setup

Nothing interesting happens here, but skipping it has burned us three times (committing to main is a repeat offense in this project), so it is a real task.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
git checkout main && git pull
git checkout -b issue-616-no-pause-in-handlers
git branch --show-current   # MUST print issue-616-no-pause-in-handlers
```

- [ ] **Step 2: Baseline build**

Run: `make > /tmp/616-task0-build.log 2>&1; tail -5 /tmp/616-task0-build.log`
Expected: build completes without errors. If the baseline is already broken, stop and report; do not build on a broken base.

---

### Task 1: The carrier on StateStack

**What this task does.** Adds the new field that everything else reads, plus the two methods around it. After this task, a `StateStack` can hold the list of executing handler entries, copy it from a parent stack, and assert that no handler is executing anywhere under it. Nothing writes the field yet — the dispatcher starts writing it in Task 3. The field is deliberately not serialized: no interrupt-pause checkpoint may exist while it is non-empty (Task 5 enforces that), so a deserialized stack correctly starts empty, and there is nothing to serialize.

**Why the assertion walks branches.** From Part 1: branches hang off `State` frames, and a mark can live on a branch stack (a tool-call branch created inside a handler) while the parent stack is unmarked. An assertion that only checked the top-level list would be blind exactly where the propagation logic is most subtle.

**Files:**
- Modify: `lib/runtime/state/stateStack.ts` (class `StateStack` starts at :342; the non-serialized fields live around :369-373)
- Test: `lib/runtime/state/stateStack.executingHandlers.test.ts` (create)

**Interfaces:**
- Consumes: `HandlerEntry` — the `{ fn: HandlerFn; liveGuardIds: string[] }` type from `lib/runtime/types.ts:63`. Already exists.
- Produces (all three names are new, invented by this plan; later tasks use them verbatim):
  - `StateStack.executingHandlerEntries: HandlerEntry[]`
  - `StateStack.adoptExecutingHandlersFrom(parent: StateStack): void`
  - `StateStack.assertNoExecutingHandlers(): void`

- [ ] **Step 1: Write the failing test**

Create `lib/runtime/state/stateStack.executingHandlers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { StateStack, State } from "./stateStack.js";
import type { HandlerEntry } from "../types.js";

const entry = (): HandlerEntry => ({ fn: async () => undefined, liveGuardIds: [] });

describe("StateStack.executingHandlerEntries", () => {
  it("starts empty and is not serialized", () => {
    const stack = new StateStack();
    expect(stack.executingHandlerEntries).toEqual([]);
    stack.executingHandlerEntries.push(entry());
    expect("executingHandlerEntries" in stack.toJSON()).toBe(false);
    const revived = StateStack.fromJSON(stack.toJSON());
    expect(revived.executingHandlerEntries).toEqual([]);
  });

  it("adoptExecutingHandlersFrom copies a snapshot, not an alias", () => {
    const parent = new StateStack();
    const e = entry();
    parent.executingHandlerEntries.push(e);
    const child = new StateStack();
    child.adoptExecutingHandlersFrom(parent);
    expect(child.executingHandlerEntries).toEqual([e]);
    expect(child.executingHandlerEntries[0]).toBe(e); // same entry OBJECT: exclusion is identity-based
    parent.executingHandlerEntries.pop();
    expect(child.executingHandlerEntries).toEqual([e]); // parent pop does not reach the child
  });

  it("assertNoExecutingHandlers passes on a clean stack with frames", () => {
    const stack = new StateStack();
    stack.stack.push(new State());
    expect(() => stack.assertNoExecutingHandlers()).not.toThrow();
  });

  it("assertNoExecutingHandlers throws when the top-level list is non-empty", () => {
    const stack = new StateStack();
    stack.executingHandlerEntries.push(entry());
    expect(() => stack.assertNoExecutingHandlers()).toThrow(/handler function is executing/);
  });

  it("assertNoExecutingHandlers finds a mark on a nested branch under an unmarked parent", () => {
    const stack = new StateStack();
    const frame = new State();
    stack.stack.push(frame);
    const branch = frame.newBranch("tool_x");
    branch.stack.executingHandlerEntries.push(entry());
    expect(() => stack.assertNoExecutingHandlers()).toThrow(/handler function is executing/);
  });
});
```

One adaptation may be needed: if `new State()` requires constructor arguments, open `class State` at stateStack.ts:71 and construct a frame the way the existing tests under `lib/runtime/state/` do. Do not change the assertions.

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm test:run lib/runtime/state/stateStack.executingHandlers.test.ts > /tmp/616-task1-fail.log 2>&1; tail -20 /tmp/616-task1-fail.log`
Expected: FAIL — `executingHandlerEntries` does not exist yet. If it fails for a different reason (import error, `State` construction), fix the test setup first.

- [ ] **Step 3: Implement**

In `lib/runtime/state/stateStack.ts`, add a type-only import at the top of the file. Type-only matters: a value import could create a runtime dependency cycle between the state module and `types.ts`; a type import is erased at compile time and cannot.

```ts
import type { HandlerEntry } from "../types.js";
```

In `class StateStack`, next to the other non-serialized fields (near `interrupted` at :372), add:

```ts
  /** Handler entries executing on this branch, innermost last. The
   *  dispatcher (runHandlerChain) pushes before a handler body runs and
   *  pops after; self-exclusion and the in-handler pause refusals read
   *  this list. Lives on the stack rather than an AsyncLocalStorage so
   *  every reader reaches it through a plain object reference it
   *  already holds — there is no ambient lookup to lose. Never
   *  serialized: no interrupt-pause checkpoint may exist while it is
   *  non-empty (assertNoExecutingHandlers), so a deserialized stack
   *  correctly starts empty.
   *  See docs/superpowers/specs/2026-07-19-issue-616-no-pause-inside-handlers-design.md */
  executingHandlerEntries: HandlerEntry[] = [];

  /** Snapshot the parent mark into this branch stack. runBatch calls
   *  this alongside guard rehydration for every branch it starts: a
   *  branch created while a handler executes runs while that handler
   *  executes (all runBatch modes join before returning), so it
   *  inherits the exclusion identity and the no-pause refusal. A
   *  snapshot, not a shared reference — the parent pops its entries on
   *  handler exit and the branch must not observe that mid-flight. */
  adoptExecutingHandlersFrom(parent: StateStack): void {
    this.executingHandlerEntries = [...parent.executingHandlerEntries];
  }

  /** Throw if any handler is executing on this stack or any branch
   *  under it. Called at the four interrupt-pause checkpoint sites:
   *  handlers have no step address, so a pause taken mid-handler could
   *  never be resumed. Walks branches because a mark can live on a
   *  branch stack whose parent is unmarked (a tool-call branch created
   *  inside a handler). */
  assertNoExecutingHandlers(): void {
    if (this.executingHandlerEntries.length > 0) {
      throw new Error(
        "Cannot pause the run while a handler function is executing: " +
          "handlers have no step address, so this checkpoint could never " +
          "be resumed. This is a runtime bug — an in-handler pause path " +
          "was reached. See issue #616.",
      );
    }
    for (const frame of this.stack) {
      for (const key of Object.keys(frame.branches ?? {})) {
        frame.branches![key]!.stack.assertNoExecutingHandlers();
      }
    }
  }
```

Check the branch field name on `State` before assuming: `newBranch` at :134 writes `this.branches`, and it may be optional. Adjust the `?? {}` guard to match reality. `toJSON` and `fromJSON` need **no** edits — the field is simply absent from `StateStackJSON`, which the first test proves.

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm test:run lib/runtime/state/stateStack.executingHandlers.test.ts > /tmp/616-task1-pass.log 2>&1; tail -10 /tmp/616-task1-pass.log`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # verify: issue-616-no-pause-in-handlers
git add lib/runtime/state/stateStack.ts lib/runtime/state/stateStack.executingHandlers.test.ts
git commit -m "feat: executing-handler mark on StateStack with branch-subtree assertion (#616)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The pending-promise watermark

**What this task does.** Gives `PendingPromiseStore` the two small methods the dispatcher needs in Task 3 to make handler exit an await boundary for *only the handler's own* async calls. Recall the deadlock from Part 2: the pending set can contain the very async call whose raise is being dispatched, and that promise cannot settle until the dispatch returns — so awaiting the whole set at handler exit hangs forever. The watermark is the position of the store's key counter at the moment the handler starts; `keysSince(mark)` returns the still-pending keys registered at or after it, which by construction excludes the deadlock-shaped promise.

**How the store works today**, so the additions make sense: `add(promise)` registers under the key `` `__pending_${counter++}` `` and returns the key (pendingPromiseStore.ts:13-17). `awaitPending(keys)` awaits exactly those keys, delivers results to their resolvers, and deletes them (:19-35). We add reading APIs only; no existing behavior changes.

**Files:**
- Modify: `lib/runtime/state/pendingPromiseStore.ts`
- Test: `lib/runtime/state/pendingPromiseStore.test.ts` (create; if the file already exists, extend it)

**Interfaces:**
- Produces (new names, invented by this plan): `watermark(): number`, `keysSince(mark: number): string[]`. Task 3 combines them as `ctx.pendingPromises.awaitPending(ctx.pendingPromises.keysSince(mark))`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { PendingPromiseStore } from "./pendingPromiseStore.js";

describe("PendingPromiseStore watermark", () => {
  it("keysSince returns only keys registered at or after the mark", () => {
    const store = new PendingPromiseStore();
    store.add(Promise.resolve(1));
    const mark = store.watermark();
    const k1 = store.add(Promise.resolve(2));
    const k2 = store.add(Promise.resolve(3));
    expect(store.keysSince(mark).sort()).toEqual([k1, k2].sort());
  });

  it("keysSince skips keys that were already awaited", async () => {
    const store = new PendingPromiseStore();
    const mark = store.watermark();
    const k1 = store.add(Promise.resolve("a"));
    await store.awaitPending([k1]);
    const k2 = store.add(Promise.resolve("b"));
    expect(store.keysSince(mark)).toEqual([k2]);
  });

  it("awaitPending(keysSince(mark)) leaves pre-mark promises alone", async () => {
    const store = new PendingPromiseStore();
    let preSettled = false;
    store.add(new Promise<void>((r) => setTimeout(() => { preSettled = true; r(); }, 5)));
    const mark = store.watermark();
    store.add(Promise.resolve("post"));
    await store.awaitPending(store.keysSince(mark));
    expect(preSettled).toBe(false); // the slow pre-mark promise was not awaited
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm test:run lib/runtime/state/pendingPromiseStore.test.ts > /tmp/616-task2-fail.log 2>&1; tail -20 /tmp/616-task2-fail.log`
Expected: FAIL — `store.watermark is not a function`.

- [ ] **Step 3: Implement**

Add to the class in `lib/runtime/state/pendingPromiseStore.ts`:

```ts
  /** Position marker for keysSince. Handler dispatch records this
   *  before running a handler body so handler exit can await exactly
   *  the promises the handler launched — awaiting the full set would
   *  deadlock on the async call whose raise is being dispatched. */
  watermark(): number {
    return this.counter;
  }

  /** Still-pending keys registered at or after the given watermark. */
  keysSince(mark: number): string[] {
    return Object.keys(this.pending).filter(
      (k) => Number(k.slice("__pending_".length)) >= mark,
    );
  }
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm test:run lib/runtime/state/pendingPromiseStore.test.ts > /tmp/616-task2-pass.log 2>&1; tail -10 /tmp/616-task2-pass.log`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add lib/runtime/state/pendingPromiseStore.ts lib/runtime/state/pendingPromiseStore.test.ts
git commit -m "feat: watermark API on PendingPromiseStore for scoped awaits (#616)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: The carrier swap in the dispatcher; retire the ALS

**What this task does.** This is the heart of the change. Five things happen together, and they must land together because they are one semantic move — splitting them would leave a window where exclusion reads one carrier and the refusal reads the other, and the #611 regression tests would fail between commits:

1. `runHandlerChain` marks the stack instead of the ALS: push the entry before the handler body, pop in a `finally`.
2. Self-exclusion reads the stack list instead of the ALS.
3. `renderVerdict`'s refusal reads the stack, threaded through as a parameter.
4. Handler exit awaits the handler's own pending promises (the Task 2 watermark), *before* the pop, so stragglers finish while the mark is still set.
5. Dispatch with handlers registered but no stack becomes a hard error, and `executingHandlers.ts` is deleted.

**Why the no-stack throw.** `interruptWithHandlers` types its stack parameter as optional, and every production call site passes one (both codegen templates pass `__stateStack()`; `agencyInterrupt.ts`, `guardTripInterrupt.ts`, and the IPC relay pass theirs — all verified during design). If some future call site forgets, the new code would degrade exactly like a lost ALS: no exclusion, silent refusal. That is the failure class this whole plan exists to kill, so it gets the same treatment as the checkpoint sites: fail loudly at the source.

**A behavioral detail to preserve.** The current code snapshots the executing set once before the chain loop (interrupts.ts:250) rather than reading it live per iteration. Keep that: the snapshot is taken with `[...]`. Nested dispatches during a handler body push and pop their own entries; the outer loop must not see them.

**Files:**
- Modify: `lib/runtime/interrupts.ts` — imports :24-27, `runHandlerChain` :227, snapshot :250, skip :268, invocation block :278-291, `renderVerdict` :436 and its refusal :479, the single `renderVerdict` call site :552
- Delete: `lib/runtime/executingHandlers.ts`
- Modify: `lib/runtime/interrupts.test.ts` — existing tests register handlers and pass no stack; they will hit the new throw and need a stack argument
- Test: `lib/runtime/interrupts.executingHandlers.test.ts` (create)

**Interfaces:**
- Consumes: `stack.executingHandlerEntries` (Task 1), `ctx.pendingPromises.watermark()` / `keysSince(mark)` (Task 2).
- Produces: `renderVerdict(merged, ctx, interruptId, interruptObj, resolvedBy, stack)` — new trailing parameter `stack: StateStack | undefined`. `runHandlerChain` throws `Error(/no StateStack/)` when `ctx.handlers` is non-empty and `stack` is undefined.

- [ ] **Step 1: Write the failing tests**

Create `lib/runtime/interrupts.executingHandlers.test.ts`. The `makeCtx` idiom is copied from the existing `lib/runtime/interrupts.test.ts:24-32`; `RuntimeContext` is the runtime's per-run context object, and `ctx.handlers` is the registered handler chain (an array of `HandlerEntry`, walked last-registered-first).

```ts
import { describe, it, expect } from "vitest";
import { interruptWithHandlers, isRejected } from "./interrupts.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import type { HandlerEntry } from "./types.js";

const makeCtx = (): RuntimeContext<any> =>
  new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });

describe("stack-carried handler execution mark", () => {
  it("throws when handlers are registered but no stack is passed", async () => {
    const ctx = makeCtx();
    ctx.handlers = [{ fn: async () => ({ type: "approve" }), liveGuardIds: [] }];
    await expect(
      interruptWithHandlers("std::x", "m", {}, "o", ctx, undefined),
    ).rejects.toThrow(/no StateStack/);
  });

  it("marks the stack for the duration of a handler body", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let seenDuring = -1;
    ctx.handlers = [
      {
        fn: async () => {
          seenDuring = stack.executingHandlerEntries.length;
          return { type: "approve" };
        },
        liveGuardIds: [],
      },
    ];
    await interruptWithHandlers("std::x", "m", {}, "o", ctx, stack);
    expect(seenDuring).toBe(1);
    expect(stack.executingHandlerEntries).toEqual([]);
  });

  it("a handler never hears a raise made from its own body (exclusion via the stack)", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let selfHeard = 0;
    let outerHeard = 0;
    const inner: HandlerEntry = {
      fn: async (intr: any) => {
        if (intr.effect === "inner::raise") { selfHeard++; return { type: "approve" }; }
        const verdict = await interruptWithHandlers("inner::raise", "m", {}, "o", ctx, stack);
        return { type: "approve", value: verdict };
      },
      liveGuardIds: [],
    };
    const outer: HandlerEntry = {
      fn: async (intr: any) => {
        if (intr.effect === "inner::raise") outerHeard++;
        return { type: "approve" };
      },
      liveGuardIds: [],
    };
    ctx.handlers = [outer, inner]; // chain walks last-registered first, so `inner` runs first
    await interruptWithHandlers("kickoff", "m", {}, "o", ctx, stack);
    expect(selfHeard).toBe(0);
    expect(outerHeard).toBe(1);
  });

  it("an unanswered raise from inside a handler is refused as a rejection", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let refusal: any = null;
    ctx.handlers = [
      {
        fn: async (intr: any) => {
          if (intr.effect === "kickoff") {
            refusal = await interruptWithHandlers("nobody::answers", "m", {}, "o", ctx, stack);
          }
          return { type: "approve" };
        },
        liveGuardIds: [],
      },
    ];
    await interruptWithHandlers("kickoff", "m", {}, "o", ctx, stack);
    expect(isRejected(refusal)).toBe(true);
    expect(refusal.value).toMatch(/inside a handler/);
  });

  it("handler exit awaits promises the handler launched, while the mark is still set", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let markAtStragglerEnd = -1;
    ctx.handlers = [
      {
        fn: async () => {
          ctx.pendingPromises.add(
            (async () => {
              await new Promise((r) => setTimeout(r, 10));
              markAtStragglerEnd = stack.executingHandlerEntries.length;
            })(),
          );
          return { type: "approve" }; // handler returns while the straggler still runs
        },
        liveGuardIds: [],
      },
    ];
    await interruptWithHandlers("kickoff", "m", {}, "o", ctx, stack);
    expect(markAtStragglerEnd).toBe(1); // straggler finished BEFORE the pop
    expect(stack.executingHandlerEntries).toEqual([]);
  });

  it("handler exit does not await promises launched before the handler began", async () => {
    const ctx = makeCtx();
    const stack = new StateStack();
    let preSettled = false;
    ctx.pendingPromises.add(
      new Promise<void>((r) => setTimeout(() => { preSettled = true; r(); }, 30)),
    );
    ctx.handlers = [{ fn: async () => ({ type: "approve" }), liveGuardIds: [] }];
    await interruptWithHandlers("kickoff", "m", {}, "o", ctx, stack);
    expect(preSettled).toBe(false); // the deadlock-shaped promise was left alone
  });
});
```

- [ ] **Step 2: Run, verify the new tests fail**

Run: `pnpm test:run lib/runtime/interrupts.executingHandlers.test.ts > /tmp/616-task3-fail.log 2>&1; tail -30 /tmp/616-task3-fail.log`
Expected: the no-stack test fails (nothing throws yet), and the mark tests fail (the list is never populated). Read the log; do not proceed on unexpected failures.

- [ ] **Step 3: Implement in `interrupts.ts`**

3a. Delete the import block at :24-27 (`runAsHandler`, `executingHandlers`, `insideHandlerFunction` from `./executingHandlers.js`).

3b. At the top of `runHandlerChain` (:233, before the depth check), add the no-stack guard:

```ts
  if ((ctx.handlers ?? []).length > 0 && !stack) {
    throw new Error(
      "Interrupt dispatch reached runHandlerChain with handlers registered but no StateStack. " +
        "The executing-handler mark lives on the stack; dispatching without one would silently " +
        "disable self-exclusion and the in-handler pause refusal. Pass the raising branch " +
        "stack to interruptWithHandlers / gatherChainOutcome.",
    );
  }
```

3c. Replace the snapshot at :250. Old line: `const executing = executingHandlers();`. New line:

```ts
    const executing = stack ? [...stack.executingHandlerEntries] : [];
```

The skip at :268 (`if (executing.includes(entry)) continue;`) is unchanged — identity by reference works the same whether the entries came from an ALS or the stack.

3d. Replace the invocation block at :278-291. The old block wraps `entry.fn` in `runAsHandler`. The new block pushes the entry, records the watermark, runs the body, then in the `finally`: awaits the handler's stragglers first (while the mark is still set, so their guard trips still refuse), then pops, then restores the tool-call and suspension state:

```ts
        const suspensionToken = stack
          ? stack.beginSuspension(entry.liveGuardIds)
          : undefined;
        stack!.executingHandlerEntries.push(entry);
        const promiseWatermark = ctx.pendingPromises.watermark();
        // Treat handler execution as atomic for the debugger — same as LLM tool calls.
        ctx.enterToolCall();
        let result: any;
        try {
          result = await entry.fn(interruptObj);
        } finally {
          try {
            // Handler exit is an await boundary for the promises the
            // handler launched: an async call that outlived the body
            // would otherwise keep running un-marked. Scoped by the
            // watermark, not awaitAll — the full pending set can
            // contain the async call whose raise is being dispatched
            // right now, which cannot settle until this chain returns.
            await ctx.pendingPromises.awaitPending(
              ctx.pendingPromises.keysSince(promiseWatermark),
            );
          } finally {
            const idx = stack!.executingHandlerEntries.lastIndexOf(entry);
            if (idx !== -1) stack!.executingHandlerEntries.splice(idx, 1);
            ctx.exitToolCall();
            if (suspensionToken !== undefined) {
              stack!.endSuspension(suspensionToken);
            }
          }
        }
```

The `stack!` assertions are safe: this loop only runs when `ctx.handlers` is non-empty, and 3b threw in that case if the stack was missing. The `lastIndexOf` + `splice` (instead of `pop`) removes this specific entry by identity even if a nested dispatch reordered things.

3e. `renderVerdict`: add the trailing parameter `stack: StateStack | undefined` to the signature at :436-442, and replace the refusal condition at :479. Old: `if (insideHandlerFunction()) {`. New:

```ts
  if ((stack?.executingHandlerEntries.length ?? 0) > 0) {
```

Keep the refusal message and the surrounding comment block (the notes about the single call site and about propagation beating approval still hold). If any comment sentence names the ALS, reword it to name the stack.

3f. Update the one call site at :552:

```ts
  return renderVerdict(outcome, ctx, interruptId, interruptObj, parentDecided ? "ipc" : "handler", stack);
```

3g. Delete `lib/runtime/executingHandlers.ts`, then prove nothing dangles:

Run: `grep -rn "executingHandlers\|runAsHandler\|insideHandlerFunction" lib/ tests/ --include="*.ts" | grep -v "executingHandlerEntries"`
Expected: zero hits. Fix any stragglers, including in test files.

- [ ] **Step 4: Repair the existing tests that now hit the no-stack throw**

`lib/runtime/interrupts.test.ts` registers handlers and calls `interruptWithHandlers(...)` / `gatherChainOutcome(...)` without a stack. Add `import { StateStack } from "./state/stateStack.js";` and pass `new StateStack()` at each such call site. Find them by running the file:

Run: `pnpm test:run lib/runtime/interrupts.test.ts > /tmp/616-task3-existing.log 2>&1; tail -30 /tmp/616-task3-existing.log`
Fix until PASS. Then check the neighbors that also drive dispatch: `pnpm test:run lib/runtime/agencyInterrupt.test.ts lib/runtime/effectMerge.test.ts > /tmp/616-task3-neighbors.log 2>&1; tail -20 /tmp/616-task3-neighbors.log` and repair the same way if they trip the throw.

- [ ] **Step 5: Run the new tests, verify they pass**

Run: `pnpm test:run lib/runtime/interrupts.executingHandlers.test.ts lib/runtime/interrupts.test.ts > /tmp/616-task3-pass.log 2>&1; tail -15 /tmp/616-task3-pass.log`
Expected: all PASS.

- [ ] **Step 6: Build, then run the #611 regression net**

These five agency tests are the behavioral contract of the self-exclusion feature. The carrier swap must be invisible to every one of them.

```bash
make > /tmp/616-task3-build.log 2>&1; tail -3 /tmp/616-task3-build.log
pnpm run agency test tests/agency/handlers/handler-raises-outer-approves.agency > /tmp/616-task3-agency.log 2>&1
pnpm run agency test tests/agency/handlers/handler-raises-outer-rejects.agency >> /tmp/616-task3-agency.log 2>&1
pnpm run agency test tests/agency/handlers/handler-propagate-refused.agency >> /tmp/616-task3-agency.log 2>&1
pnpm run agency test tests/agency/handlers/handler-raises-depth.agency >> /tmp/616-task3-agency.log 2>&1
pnpm run agency test tests/agency/handlers/handle-survives-restore.agency >> /tmp/616-task3-agency.log 2>&1
tail -40 /tmp/616-task3-agency.log
```

Expected: all pass. If one fails, read the log and fix before committing — do not carry a red regression net forward.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add -A lib/runtime/
git status   # confirm executingHandlers.ts shows as deleted
git commit -m "feat: move executing-handler mark from ALS to StateStack, retire executingHandlers.ts (#616)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The three guard-trip refusal doors

**What this task does.** Implements layer 1 from Part 2 in `lib/runtime/guardTripInterrupt.ts`: the persisted-id door, the unanswered-dispatch door, and the checkpoint door. After this task, a guard trip raised while the stack is marked can only end two ways — answered by an outer handler, or thrown as the original `GuardExceededError`. It can never persist a question id, create a checkpoint, or halt the runner.

**What "throw the original error" means downstream, so you can trust it:** `raiseGuardTripsAtStep`'s caller is `Runner.step`, inside compiled code. A thrown `GuardExceededError` unwinds to the guard block boundary, which converts it into a failed Result (with draft salvage if a `saveDraft` ran). That is byte-for-byte the same path a handler *rejecting* the trip takes today (`applyVerdict` at guardTripInterrupt.ts:215 does `throw err` on reject). We are not inventing an outcome; we are routing "unanswered inside a handler" onto the existing "rejected" rails.

**Files:**
- Modify: `lib/runtime/guardTripInterrupt.ts` — `raiseOneTrip` :78 (persisted branch :91-115, unanswered persist :152-154), `raiseGuardTripsAtStep` checkpoint at :322
- Test: `lib/runtime/guardTripInterrupt.inHandler.test.ts` (create)

**Interfaces:**
- Consumes: `stack.executingHandlerEntries` and `stack.assertNoExecutingHandlers()` from Task 1.
- Behavior contract for later tasks: an in-handler trip that cannot be answered rejects with the original `GuardExceededError`; nothing lands in `stack.other`; no checkpoint is created.

- [ ] **Step 1: Write the failing tests**

Constructing a real armed `Guard` on a `StateStack` in isolation is the hard part of this task, and inventing that setup from the armchair risks a test that fights the guard model instead of testing the refusal. So: first read how the existing guard unit tests construct guards — look for `guard.test.ts`, `guardScope.test.ts`, or guard construction inside `lib/runtime/state/` tests (`grep -rln "TimeGuard\|GuardExceededError" lib/runtime --include="*.test.ts"`), and mirror that idiom. The two tests to write, specified by behavior:

**Test A — the persisted-id door.** Arrange: a `StateStack` holding one armed, over-budget, non-root time guard; the matching `GuardExceededError` as `err`; a persisted question id in `stack.other` under the guard-trip key (as if a previous surface happened) with **no** recorded answer in the ctx; the stack marked with one handler entry. Act: `await raiseGuardTripsUntilClear(ctx, stack, () => err)` — the third argument overrides trip detection, which is how the production step gate already calls it. Assert: it rejects with `err` itself, and `stack.other` gained no new keys (the stale persisted key was cleaned up, not re-surfaced).

**Test B — the unanswered-dispatch door.** Arrange: same guard and error; no persisted id; `ctx.handlers = []` so nobody answers; the stack marked. Act: same call. Assert: it rejects with `err`; no `__guardTrip_` key exists in `stack.other`; `ctx.checkpoints` contains no checkpoint. (Note the mechanics: with the stack marked, `renderVerdict` from Task 3 already refuses the unanswered dispatch as a rejection, and `applyVerdict` converts that rejection into `throw err`. Test B therefore passes through the *refusal* path, and the belt added in Step 3c below is unreachable — the test pins the observable contract, not which line threw.)

If, after a genuine attempt, guard construction in isolation proves impractical, fall back to writing these two as agency-js tests (see `docs/misc/TESTING.md`) — but try the unit route first and say in the commit message which route you took.

- [ ] **Step 2: Run, verify they fail**

Run: `pnpm test:run lib/runtime/guardTripInterrupt.inHandler.test.ts > /tmp/616-task4-fail.log 2>&1; tail -25 /tmp/616-task4-fail.log`
Expected: Test A fails — today the persisted branch re-surfaces the interrupt (returns it) instead of throwing. Test B may already partially hold through the Task 3 refusal; what must be red before the fix is the *persisted-branch* behavior. Confirm in the log which assertions fail and why before proceeding.

- [ ] **Step 3: Implement in `guardTripInterrupt.ts`**

3a. At the top of `raiseOneTrip` (:78), after `key` is computed:

```ts
  const inHandler = stack.executingHandlerEntries.length > 0;
```

3b. The persisted-id branch: the recorded-answer path (:94-98) stays untouched. Immediately before the open-question re-surface (the `const snapshot = ...` at :104), add:

```ts
    // A persisted open question must not re-surface from inside a
    // handler: re-surfacing pauses, and a handler cannot pause. The
    // trip stands as a rejection; the guard boundary converts it. The
    // stale key is dropped so a later out-of-handler replay does not
    // resurrect a question whose trip already resolved as a rejection.
    if (inHandler) {
      delete stack.other[key];
      throw err;
    }
```

3c. The unanswered branch (:152-154). Old code persists then returns. New code refuses first:

```ts
      const interrupts = verdict as Interrupt[];
      if (inHandler) {
        // renderVerdict refuses unanswered raises when the stack is
        // marked, so this is unreachable — kept because reaching it
        // would mean a pause was about to be persisted from inside a
        // handler, and that must fail loudly, not poison resumes.
        throw err;
      }
      stack.other[key] = interrupts[0].interruptId;
      return interrupts;
```

3d. In `raiseGuardTripsAtStep`, immediately before `ctx.checkpoints.create` at :322:

```ts
  stack.assertNoExecutingHandlers();
```

- [ ] **Step 4: Run, verify they pass**

Run: `pnpm test:run lib/runtime/guardTripInterrupt.inHandler.test.ts > /tmp/616-task4-pass.log 2>&1; tail -10 /tmp/616-task4-pass.log`

- [ ] **Step 5: Build, run the guard regression tests**

The healthy paths must not move: a trip answered by an outer handler (the supervise shape), a trip approved at a checkpoint, a plain time trip.

```bash
make > /tmp/616-task4-build.log 2>&1; tail -3 /tmp/616-task4-build.log
pnpm run agency test tests/agency/guards/guard-time-trip.agency > /tmp/616-task4-agency.log 2>&1
pnpm run agency test tests/agency/guards/trip-approve.agency >> /tmp/616-task4-agency.log 2>&1
pnpm run agency test tests/agency/guards/trip-time.agency >> /tmp/616-task4-agency.log 2>&1
pnpm run agency test tests/agency/handlers/handler-guard-trip.agency >> /tmp/616-task4-agency.log 2>&1
tail -40 /tmp/616-task4-agency.log
```

Expected: all pass. `handler-guard-trip` is the wall-clock-flaky one (issue #575); if it alone fails, read its output before concluding this change broke it — an exact-count mismatch under load is the known flake, a recursion error is a real regression.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add lib/runtime/guardTripInterrupt.ts lib/runtime/guardTripInterrupt.inHandler.test.ts
git commit -m "fix: in-handler guard trips reject instead of pausing, incl persisted-id resume branch (#616)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Branch inheritance and the other three pause-site assertions

**What this task does.** Two related wirings. First, branch stacks inherit the mark: `rehydrateInheritedGuards` in `runBatch.ts` — the helper that already copies parent guard state into every branch at start and on resume — additionally calls `adoptExecutingHandlersFrom`. This is what makes the refusal reach a guard trip inside a tool-call branch inside a handler. Second, the remaining three interrupt-pause sites get the same assertion Task 4 gave the step gate. All three are unreachable-by-design after layers 1 and 2; the assertions are the enforcement of "unreachable."

**Why the copy is not in `newBranch`:** `newBranch` is a method on `State` (the frame), and a frame has no reference to the `StateStack` that owns it, so it cannot see the parent's list. `rehydrateInheritedGuards` has both stacks in hand, runs for every branch of every one of `runBatch`'s four callers, and is the established precedent for exactly this kind of parent-to-branch inheritance.

**Files:**
- Modify: `lib/runtime/runBatch.ts` — `rehydrateInheritedGuards` :317-322; batch checkpoint :529
- Modify: `lib/runtime/agencyInterrupt.ts` — checkpoint at :189
- Modify: `lib/runtime/promptRunner.ts` — checkpoint at :112

**Interfaces:**
- Consumes: `adoptExecutingHandlersFrom` and `assertNoExecutingHandlers` from Task 1. No new names produced.

- [ ] **Step 1: Wire the adoption in `runBatch.ts`**

In `rehydrateInheritedGuards` (:317-322), after the existing rehydration line:

```ts
  branch.stack.rehydrateInheritedGuardsFrom(parentStack);
  branch.stack.adoptExecutingHandlersFrom(parentStack);
```

(Keep the function's existing signature and doc comment; extend the comment with one sentence saying branch stacks also inherit the executing-handler snapshot, and why: a branch created during a handler runs during that handler.)

- [ ] **Step 2: Add the three assertions**

Each one goes immediately before the `ctx.checkpoints.create` call, on the same stack that call captures.

`agencyInterrupt.ts`, before :189:

```ts
  stack.assertNoExecutingHandlers();
  const checkpointId = ctx.checkpoints.create(stack, ctx, {
```

`promptRunner.ts`, before :112 (the stack captured there is `this.opts.stateStack`):

```ts
      this.opts.stateStack.assertNoExecutingHandlers();
      const cpId = this.opts.ctx.checkpoints.create(
        this.opts.stateStack,
```

If `stateStack` is typed optional in `PromptRunnerOpts`, use `this.opts.stateStack?.assertNoExecutingHandlers();`.

`runBatch.ts`, at :529, after the `beforeCheckpoint` hook and before the create:

```ts
  hooks?.beforeCheckpoint?.();
  parentStack.assertNoExecutingHandlers();
  const cpId = ctx.checkpoints.create(parentStack, ctx, checkpointLocation);
```

- [ ] **Step 3: Build and run the touched-area tests**

The adoption and the assertions have no new unit test of their own — `assertNoExecutingHandlers` and `adoptExecutingHandlersFrom` were pinned in Task 1, and the end-to-end proof that adoption wires correctly is Task 6's fixtures plus the fork regression tests here. What this step proves is the negative: healthy fork, race, and pause paths do not trip the new assertions.

```bash
make > /tmp/616-task5-build.log 2>&1; tail -3 /tmp/616-task5-build.log
pnpm test:run lib/runtime > /tmp/616-task5-unit.log 2>&1; tail -15 /tmp/616-task5-unit.log
pnpm run agency test tests/agency/guards/trip-fork.agency > /tmp/616-task5-agency.log 2>&1
pnpm run agency test tests/agency/guards/guard-time-fork-per-branch.agency >> /tmp/616-task5-agency.log 2>&1
pnpm run agency test tests/agency/guards/guard-cost-shared-survives-interrupt.agency >> /tmp/616-task5-agency.log 2>&1
tail -30 /tmp/616-task5-agency.log
```

Expected: unit suite green, all three agency tests pass. `guard-cost-shared-survives-interrupt` matters specifically because it pauses and resumes through the batch checkpoint path this task just gated.

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add lib/runtime/runBatch.ts lib/runtime/agencyInterrupt.ts lib/runtime/promptRunner.ts
git commit -m "feat: branch stacks inherit the handler mark; all interrupt-pause sites assert it empty (#616)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The agency tests that pin issue #616

**What this task does.** Adds the two execution tests for the path that today has zero coverage: an in-handler guard trip that **nobody answers**. The existing `handler-guard-trip.agency` covers the answered path (outer handler approves, `trips:1`). These two cover refusal: one where the outer handler explicitly propagates the trip, one where there is no outer handler at all. In both, the correct behavior after this plan is: the guard block inside the handler fails with the trip error, the handler completes normally, and the run finishes without ever pausing. Before this plan, the propagate case is exactly the surface-from-inside-a-handler shape that poisons resumes.

These are Agency execution tests: they compile and run a real `.agency` program with no LLM calls, driven by a `.test.json` that names the node, the input, and the expected output.

**A timing note, honestly stated.** Like the sibling fixture, these race `spin(3000000)` against a 5ms wall-clock budget — but only in the *tripping* direction. If a miracle machine ran the spin in under 5ms, the guard would never trip, `sawFailure` would stay false, and the test would fail. The existing `handler-guard-trip.agency` has relied on the same spin exceeding 5ms since it was written, so this matches house precedent. If it ever flakes, raise the rounds (to `10000000`), never the budget.

**Files:**
- Create: `tests/agency/handlers/handler-guard-trip-propagate.agency` and `.test.json`
- Create: `tests/agency/handlers/handler-guard-trip-unhandled.agency` and `.test.json`

- [ ] **Step 1: Write the propagate fixture**

`tests/agency/handlers/handler-guard-trip-propagate.agency`:

```
// A guard INSIDE the handler body trips, and the outer handler
// PROPAGATES std::guard instead of answering. A propagated in-handler
// trip cannot ask the user (handlers cannot pause), so it is refused:
// the guard block fails with the trip error, the handler completes
// degraded, and the run never pauses. This is the issue-616 refusal
// path; the answered path lives in handler-guard-trip.agency.
let sawFailure = false

def spin(rounds: number): string {
  let count = 0
  while (count < rounds) {
    count = count + 1
  }
  return "spun"
}

def inner(): string {
  handle {
    interrupt("please review")
    return "work done"
  } with (data) {
    const guarded = guard(time: 5ms, label: "in-handler") {
      const spun = spin(3000000)
      return "guarded:${spun}"
    }
    if (isFailure(guarded)) {
      sawFailure = true
    }
    return approve()
  }
}

node main() {
  let result = ""
  handle {
    result = inner()
  } with (data) {
    if (data.effect == "std::guard") {
      return propagate()
    }
    return approve()
  }
  return "${result}|failed:${sawFailure}"
}
```

`tests/agency/handlers/handler-guard-trip-propagate.test.json` (same shape as the sibling `handler-guard-trip.test.json`):

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "An in-handler guard trip that the outer chain propagates is refused as a rejection: the guard block fails, the handler completes, the run never pauses. failed:false means the trip either paused the run or was silently approved.",
      "input": "",
      "expectedOutput": "\"work done|failed:true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [],
      "llmMocks": []
    }
  ]
}
```

- [ ] **Step 2: Write the unhandled fixture**

`tests/agency/handlers/handler-guard-trip-unhandled.agency` — the same inner shape with **no** handler in `main` at all. With no outer handler, the trip is unanswered by default, which without the refusal would pause a run that has nobody to resume it:

```
// Same shape as handler-guard-trip-propagate, with NO outer handler:
// the in-handler trip has nobody to answer it. The refusal must
// convert it to a failed guard Result instead of pausing.
let sawFailure = false

def spin(rounds: number): string {
  let count = 0
  while (count < rounds) {
    count = count + 1
  }
  return "spun"
}

def inner(): string {
  handle {
    interrupt("please review")
    return "work done"
  } with (data) {
    const guarded = guard(time: 5ms, label: "in-handler") {
      const spun = spin(3000000)
      return "guarded:${spun}"
    }
    if (isFailure(guarded)) {
      sawFailure = true
    }
    return approve()
  }
}

node main() {
  const result = inner()
  return "${result}|failed:${sawFailure}"
}
```

`tests/agency/handlers/handler-guard-trip-unhandled.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "An in-handler guard trip with no outer handler registered is refused as a rejection rather than pausing a run nobody can resume. The guard block fails, the handler completes, the run finishes.",
      "input": "",
      "expectedOutput": "\"work done|failed:true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [],
      "llmMocks": []
    }
  ]
}
```

- [ ] **Step 3: Parse-check both fixtures before running anything**

Run: `pnpm run ast tests/agency/handlers/handler-guard-trip-propagate.agency > /tmp/616-task6-ast.log 2>&1 && pnpm run ast tests/agency/handlers/handler-guard-trip-unhandled.agency >> /tmp/616-task6-ast.log 2>&1 && echo PARSE-OK`
Expected: `PARSE-OK`. If not, check the syntax against `docs/site/guide/basic-syntax.md` and the sibling fixture — the usual mistakes are missing parentheses around `if` conditions or a bare assignment without `let`.

- [ ] **Step 4: Run both tests**

```bash
pnpm run agency test tests/agency/handlers/handler-guard-trip-propagate.agency > /tmp/616-task6.log 2>&1
pnpm run agency test tests/agency/handlers/handler-guard-trip-unhandled.agency >> /tmp/616-task6.log 2>&1
tail -30 /tmp/616-task6.log
```

Expected: both PASS. If a run produces a compiled sibling `.js` next to the fixture (the existing handler fixtures store theirs), it belongs in the commit.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add tests/agency/handlers/handler-guard-trip-propagate.* tests/agency/handlers/handler-guard-trip-unhandled.*
git commit -m "test: in-handler guard trips that nobody answers are refused, never pause (#616)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Docs, final checks, PR

**What this task does.** States the new invariant where the next person will look for it, runs the project-wide checks, audits the diff against the house anti-pattern list, and opens the PR. Docs are part of the deliverable, not an afterthought: the old design failed precisely by carrying a wrong claim in a comment, and the replacement claims live in three documents people actually read.

**Files:**
- Modify: `docs/site/guide/handlers.md` (caveat 1, currently at :217)
- Modify: `docs/dev/interrupts.md`, `docs/dev/checkpointing.md`

- [ ] **Step 1: Update the handlers guide**

Caveat 1 in `docs/site/guide/handlers.md` currently reads: "**A raise nothing settles cannot ask the user.** Handler functions cannot pause, so where ordinary code would propagate to you for a decision, a handler's raise is rejected with an explanatory message..." Replace it with a version that covers guard trips:

```markdown
1. **A raise nothing settles cannot ask the user.** Handler functions cannot pause, so where ordinary code would propagate to you for a decision, a handler's raise is rejected with an explanatory message. This covers guard trips too: a `guard` block inside a handler whose trip no outer handler answers fails with the trip error instead of pausing. In practice: if your outer handlers propagate an effect, a handler raising that effect gets a failure Result, not a prompt.
```

- [ ] **Step 2: Update the dev docs**

Add a short plain-prose section to each of `docs/dev/interrupts.md` and `docs/dev/checkpointing.md` (4-6 sentences, written for a reader who has not seen this plan). The content each must carry: handlers compile to callbacks with no step address, so no interrupt-pause checkpoint may capture a stack whose `executingHandlerEntries` list is non-empty; the list lives on `StateStack` and is never serialized; the four pause sites call `assertNoExecutingHandlers()`, which walks branch stacks too; guard trips raised inside handlers reject with the original trip error instead of surfacing. Link the spec: `docs/superpowers/specs/2026-07-19-issue-616-no-pause-inside-handlers-design.md`.

- [ ] **Step 3: Full build, structural lint, runtime unit suite**

```bash
make > /tmp/616-task7-build.log 2>&1; tail -3 /tmp/616-task7-build.log
pnpm run lint:structure > /tmp/616-task7-lint.log 2>&1; tail -5 /tmp/616-task7-lint.log
pnpm test:run lib/runtime > /tmp/616-task7-unit.log 2>&1; tail -15 /tmp/616-task7-unit.log
```

Expected: build clean, lint clean, unit suite green. The agency suite stays with CI.

- [ ] **Step 4: Anti-pattern audit**

Read `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md` in full, then review the complete diff (`git diff main`). The risk spots this specific change is likely to trip:
- **Narrating comments.** Several comments were added; re-read each against the rule "states a constraint the code cannot show." Delete any that merely describe the next line or defend the change.
- **Non-null assertions.** The `stack!` uses in `runHandlerChain` are justified by the throw at the top of the function; make sure that justification is structural (the throw is close and obvious), not a comment.
- **Dynamic imports, maps, sets, interfaces.** None should appear anywhere in the diff.

- [ ] **Step 5: Commit docs, push, open the PR**

```bash
git branch --show-current
git add docs/site/guide/handlers.md docs/dev/interrupts.md docs/dev/checkpointing.md
git commit -m "docs: handlers cannot pause - guard trips inside handlers reject instead (#616)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin issue-616-no-pause-in-handlers
```

Write the PR body to `/tmp/616-pr-body.md` first (the apostrophe rule applies to PR bodies too), then:

```bash
gh pr create --title "In-handler guard trips reject instead of pausing; executing-handler mark moves to StateStack (#616)" --body-file /tmp/616-pr-body.md
```

The PR body must cover, in plain prose: the issue link and the spec path; the three layers and what each protects against (refusals close the confirmed persisted-id bypass; the stack carrier replaces the single ALS both defenses shared; the four pause sites assert); the decisions a reviewer will question — the watermark-scoped await and its deadlock rationale, why the assertion is *not* in `CheckpointStore.create` (`resumableScope.ts:125` creates pinned checkpoints inside handlers on healthy paths), and why `handlerChainDepthALS` deliberately stays. State explicitly that #575 (fake clock) must not close #616 and that the two new fixtures are the pinning tests. End with the standard generated-with line.

---

## Self-review against the spec (run during plan-writing; findings resolved)

- **Every spec section has a task:** the carrier field, adoption, and subtree assertion (Task 1); the watermark (Task 2); the dispatcher swap, no-stack throw, `renderVerdict` threading, watermark await, and ALS retirement (Task 3); all three refusal doors (Task 4); branch inheritance and the remaining pause sites (Task 5); the refusal behavior tests (Task 6); the docs including the handlers.md caveat (Task 7).
- **One spec test deliberately dropped, flagged for the owner:** the spec's test list includes "trip inside a tool-call branch inside a handler, via `llm()` with a mock client." This plan covers that path by construction (Task 5's adoption wiring) and by the fork-path regression tests, but not with a dedicated llm-mock fixture — building one adds LLM-mock machinery for a path whose runtime wiring is a one-line copy already exercised. If the owner wants the fixture anyway, it slots in as Task 6 Step 5 without touching anything else.
- **Name consistency:** `executingHandlerEntries`, `adoptExecutingHandlersFrom(parent)`, `assertNoExecutingHandlers()`, `watermark()`, `keysSince(mark)` — used with identical spelling in every task that mentions them.
- **Known soft spot, stated rather than hidden:** Task 4 Step 1 specifies its two tests by behavior and points at the existing guard-construction idiom instead of inlining a fabricated `Guard` setup. A wrong-from-the-armchair construction would be worse than a precise pointer plus a named fallback (agency-js).
