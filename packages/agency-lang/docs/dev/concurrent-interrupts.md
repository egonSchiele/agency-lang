# Concurrent Interrupts

This doc covers how Agency handles multiple interrupts that arise from concurrent execution paths.

There are three user-facing constructs that produce concurrent execution:

- **`fork(items) as item { ... }`** — runs the block in parallel for each item. Each item is a separate "branch." If multiple branches interrupt, all interrupts are batched together and returned to the caller in a single `Interrupt[]`.
- **`race(items) as item { ... }`** — same shape as fork, but only one branch wins; interrupts from losers are cancelled.
- **`llm(prompt, { tools })`** — when the LLM calls multiple tools in a single response, those tool invocations run as parallel branches inside `runPrompt`. If multiple tools interrupt, those interrupts are batched too.

The user responds to a batch via `respondToInterrupts(interrupts, responses)`. Resume reconstructs the full execution state, replays only the work that hadn't completed, and continues.

**As of the runBatch refactor (PR #186):** three call sites delegate to a single runtime primitive (a fourth adopter, `_run` for subprocess execution, was added with subprocess pause/resume — see [`runBatch.md`](runBatch.md)), [`runBatch`](../../lib/runtime/runBatch.ts), that owns the concurrent-interrupt orchestration: `Runner.runForkAll`, `Runner.runRace`, and `PromptRunner.parallel`. Previously every site hand-rolled the same `Promise.allSettled` / `Promise.race` boilerplate, made the same subtle mistakes, and was hard to keep in lock-step. After the refactor there is **one** place where branch lifecycle, abort composition, checkpoint stamping, and `intr.checkpoint` overwrite live, and thin adapter functions that wire it up.

For the primitive's API, contracts, and the slice-rule discipline in isolation, see [`docs/dev/runBatch.md`](runBatch.md). This document focuses on the bigger picture: data model, resume mechanics, and per-call-site usage.

The rest of this document is split into:

1. The shared mental model and data types (unchanged by the refactor).
2. The `runBatch` primitive itself.
3. **Implementation details**: how each call site uses `runBatch`.
4. **Usage guide**: how to add a new concurrent-interrupt site without re-introducing the same bugs.
5. The slice-rule, abort signals, resume mechanics, invariants — preserved from the pre-refactor doc because they are still load-bearing.

---

## Quick mental model

Think of each parallel branch as having its own miniature state stack. The parent frame holds a map of branches under its `branches` field. The runtime serialises this tree on interrupt, restores it on resume, and tracks which branches have completed (cached result) versus interrupted (saved checkpoint) versus never-finished (just a stack reference).

```diagram
╭─────────────────────────╮
│ main_frame              │
│   branches:             │
│   ├─ "fork_1_0": ─┐     │      ╭───────────────────────────╮
│   ├─ "fork_1_1": ─┼────▶│ BranchState                       │
│   └─ "fork_1_2": ─┘     │ ├ stack          (own StateStack) │
╰─────────────────────────╯ ├ interruptId?  (set if halted)  │
                            │ interruptData?                  │
                            │ checkpoint?    (leaf cp)        │
                            │ result?        ({ result })     │
                            │ abortController? (live-only)    │
                            ╰───────────────────────────────────╯
```

Same shape applies to tool-call branches inside `runPrompt`, just keyed differently (`tool_<toolCallId>`).

## Core data types

### `BranchState` (`lib/runtime/state/stateStack.ts`)

```ts
export type BranchState = {
  stack: StateStack;            // this branch's own isolated stack
  interruptId?: string;         // set if this branch is paused on an interrupt
  interruptData?: any;
  checkpoint?: Checkpoint;      // the LEAF checkpoint this branch produced when it interrupted
  result?: { result: any };     // set if this branch completed normally
  abortController?: AbortController;  // live, not serialised — used by race
};
```

Two important rules:

- **`result !== undefined`** means "branch finished, here's the value." On resume, `runBatch` short-circuits past this branch entirely without calling `invoke` again — unless `recordBranchOutcomes: false` is set (see below). The wrapper object distinguishes "no result" from "result was the value `undefined`."
- **`interruptId` set** means "branch paused at an interrupt." On resume, `invoke` is re-called with the saved `stack`. The inner code finds its saved `__interruptId_N` in frame locals, looks up the user's response via `ctx.getInterruptResponse`, and either continues past the interrupt or halts with rejection.

`abortController` and live computed fields are NOT serialised in `BranchStateJSON`. `abortController` is purely a live execution concept; `result` is reconstructed via the `result?: { result }` field, which IS serialised.

### `StateStack.abortSignal`

Each `StateStack` carries an optional `abortSignal?: AbortSignal`. When `runBatch` creates a branch, it sets a composed signal on the branch's stack. Anywhere downstream code holds the stack reference (e.g., `runPrompt`'s `setupFunction` call), it can use `ctx.isCancelled(stack)` and `ctx.getAbortSignal(stack)` to be branch-aware. See "Branch-aware abort signals" below.

---

## The `runBatch` primitive

`runBatch` lives in [`lib/runtime/runBatch.ts`](../../lib/runtime/runBatch.ts). Single function, three modes (`"all"`, `"sequential"`, `"race"`), tagged-union return:

```ts
export async function runBatch<T>(opts: RunBatchOpts<T>): Promise<RunBatchResult<T>>;
//   RunBatchResult<T> = { kind: "values"; values: T[] } | { kind: "interrupts"; interrupts: Interrupt[] }
```

For the full option set (`parentStack`, `parentFrame`, `checkpointLocation`, `children`, `raceWinnerLocalKey`, `recordBranchOutcomes`, `hooks`) and the `BatchChild` contract, read the JSDoc on `RunBatchOpts` in [`lib/runtime/runBatch.ts`](../../lib/runtime/runBatch.ts). Don't re-document those fields here — the source is the canonical reference.

The two callers-must-observe rules are:

- **`parentStack` MUST be the local slice** (the branch stack you were handed), NOT `ctx.stateStack`. See "Slice-only checkpoint composition" below.
- **`BatchChild.invoke` MUST RETURN `T | Interrupt[]`**, never throw an interrupt array. Other JS errors may be thrown. See "Inherited invariants → Errors win over interrupts" below.

### What `runBatch` owns

- **Per-child branch lifecycle.** Calls `parentFrame.getOrCreateBranch(child.key)`. On resume, finds the existing branch (idempotent).
- **AbortController + signal composition.** Each branch gets a fresh `AbortController`. The branch's stack `abortSignal` is composed via `AbortSignal.any([parentSig, child.signal])` so nested aborts cascade down.
- **ALS-isolated invocation.** Each `invoke` runs inside `ctx.statelogClient.runInBranchContext(parentSpanStack, …)` so concurrent branches don't interleave their span pushes/pops on the parent's stack.
- **Three modes:**
  - `"all"` — `Promise.allSettled`; every child runs concurrently.
  - `"sequential"` — `for...of` loop; each child runs after the previous resolves. Used for hook-callback batching (preserves today's `callHook` strict-ordering semantics).
  - `"race"` — `Promise.race`; first to settle wins, losers get `abortController.abort()`; loser branches deleted. **Resume dispatch is folded in**: at the top of `runBatch`, if `mode === "race"` and a winner is persisted under `raceWinnerLocalKey`, only the winner's child runs (the equivalent of the old `resumeRaceWinner`).
- **Outcome collection.** For each settled child:
  - rejection (non-interrupt error) → rethrow and abandon sibling interrupts (inherited invariant; see "Inherited invariants" below).
  - returned `Interrupt[]` → batch into the shared collection and (if `recordBranchOutcomes`) call `setInterruptOnBranch(key, id, data, leafCheckpoint)`.
  - returned value → (if `recordBranchOutcomes`) call `setResultOnBranch(key, value)`.
- **Shared checkpoint stamp + overwrite.** If any child interrupted, stamp ONE shared checkpoint at `checkpointLocation` and overwrite `intr.checkpoint` + `intr.checkpointId` on every interrupt in the batch. This overwrite is intentional (per commit c72b9c1574): every interrupt in a batch deliberately resumes from the same point.
- **Cost-propagation hooks.** `seedBranchCost` / `propagateBranchCost` for mode `"all"` / `"sequential"`. For mode `"race"`, the asymmetric pair `propagateLoserCost` / `propagateWinnerCost` (losers eagerly at race time, winner deferred until winner-branch finally completes).
- **Cleanup on success.** No-interrupt success path: propagate cost, then `parentFrame.popBranches()`.
- **Defensive guards.** Duplicate-child-key check; mode-flip mismatch assert (if `raceWinnerLocalKey` holds a number but `mode !== "race"`, throw a clear error).

### What `runBatch` deliberately does NOT touch

Per commit c72b9c1574 (which removed the buggy `isForked` approach that broke nested-fork composition):

- **The leaf `interruptReturn` template.** It still stamps a per-leaf checkpoint exactly as today. `runBatch` reads that leaf checkpoint off each surfaced `Interrupt` and writes it to `BranchState.checkpoint`. The leaf checkpoint is the vehicle that carries the pre-pop branch stack into `State.toJSON`'s branches walk.
- **Handler bookkeeping.** Per-branch `handle` chains stay as they were.
- **In-flight checkpoint key shapes.** The race adapter passes `raceWinnerLocalKey: __race_winner_<id>` — the existing shape, preserved deliberately for checkpoint compatibility.

### `recordBranchOutcomes`: when to set it false

By default `runBatch` records branch outcomes itself via `setResultOnBranch` / `setInterruptOnBranch`. That's what fork and race need.

`runPrompt`'s tool loop sets `recordBranchOutcomes: false` because the per-tool body (`runInvokeStep` in `prompt.ts`) already records branch state — `setResultOnBranch(branchKey, toolResult)` happens inside the body before it returns. If `runBatch` then also called `setResultOnBranch(key, undefined)` (the body returns `void`), it would destroy the meaningful tool result that `runPrompt` reads on resume (around `prompt.ts` line 723).

When this flag is false, `runBatch` also **disables the cached-branch short-circuit**. The reason: `branch.result` being set no longer means "the body is fully done" — for the tool loop it may only mean "the tool's `invoke` step succeeded; the `.end` and `.log` steps still need to fire on resume." Idempotency in that mode is the caller's responsibility (`BranchRunner.step`'s `completedSteps` for the tool loop).

### Inherited invariants

These behaviours come from the pre-refactor code; `runBatch` preserves them exactly.

- **Internal runtime errors win over interrupts.** Agency itself uses Result/Failure for user-facing tool errors, not JS exceptions ([guide → error handling](https://agency-lang.com/guide/error-handling.html)). The case this invariant covers is narrower: if a child's promise *rejects* — i.e., a JS error escapes from the runtime layer (a bug in agency itself, or unhandled TypeScript code called from within a branch) — `runBatch` rethrows that error and abandons any interrupts that sibling branches collected. Same behaviour as today's `runForkAll` / `runRace`. A child that needs to surface both a failure and sibling interrupts must catch the JS error inside its own `invoke` and translate it into a Failure value.
- **Race cost asymmetry.** When the winner settles and `runBatch` aborts the losers, each loser's accumulated cost (any LLM calls it actually made before being aborted) is propagated to the parent right then. The winner's cost is *deferred*: it isn't propagated until the winner's branch finally pops on a no-interrupt resume. This matches the pre-refactor `runRace` semantics.
- **The leaf stamps its own per-branch checkpoint** at `interruptReturn`. `runBatch` reads it off the surfaced interrupt and stores it on `BranchState.checkpoint`. Do not move leaf stamping anywhere.

---

## Implementation details: how each call site uses `runBatch`

All three call sites are now thin adapters. Their job is to translate domain-specific arguments (items, blockFn, tool calls, …) into `runBatch` options and wire up domain-specific hooks (statelog events, cost helpers).

### `Runner.runForkAll` (`lib/runtime/runner.ts`)

Mode: `"all"`. `recordBranchOutcomes` defaults to true.

The adapter:

- Builds `children` from `items.map((item, i) => ({ key: forkBranchKey(id, i), invoke: (branchStack) => blockFn(item, i, branchStack) }))`.
- Hooks: `seedBranchCost`, `propagateBranchCost` delegate to `Runner`'s existing helpers. `onBranchEnd → forkBranchEnd` and `onCheckpoint → checkpointCreated` wire up the statelog events. No `propagateLoserCost`/`propagateWinnerCost` (not race).
- Returns: `result.kind === "interrupts" ? result.interrupts : result.values`.

### `Runner.runRace` (`lib/runtime/runner.ts`)

Mode: `"race"`. `recordBranchOutcomes` defaults to true. `raceWinnerLocalKey: this.raceWinnerKey(id)` (which evaluates to the existing `__race_winner_<id>` shape — unchanged for in-flight checkpoint compatibility).

The adapter:

- Same `children` construction as fork.
- Hooks: `seedBranchCost`, **asymmetric** `propagateLoserCost` / `propagateWinnerCost` (both delegating to the same `propagateBranchCost` helper; only the timing differs). `onBranchEnd → forkBranchEnd` (`"aborted"` for losers, `"interrupted"`/`"success"` for winner, `"failure"` for the first rejecting branch). `onCheckpoint → checkpointCreated` with `reason: "race"`.
- Returns: `result.kind === "interrupts" ? result.interrupts : result.values[0]` (race always has exactly one winner).

`Runner.fork` doesn't dispatch between "first run" and "resume winner" — it unconditionally calls the race adapter, and `runBatch`'s race-resume path inside the primitive handles the resume case via `raceWinnerLocalKey`.

### `runPrompt`'s tool loop (`lib/runtime/prompt.ts` + `lib/runtime/promptRunner.ts`)

Mode: `"all"`. **`recordBranchOutcomes: false`** (see above).

`PromptRunner.parallel` becomes a thin wrapper. Its new signature:

```ts
parallel<T>(
  keyPrefix: string,
  items: T[],
  keyFor: (item: T, index: number) => string,
  branchFn: (item: T, b: BranchRunner) => Promise<void>,
): Promise<RunBatchResult<void>>
```

`keyFor` MUST produce the same branch key that the `branchFn` body uses inside `stack.getOrCreateBranch(...)`. Otherwise `runBatch` allocates a separate branch from the one the body manages, and the leaf-checkpoint vehicle into `State.toJSON`'s branches walk is lost. The real call site in `prompt.ts` passes `(toolCall) => \`tool_${toolCall.id}\``.

The body still uses `BranchRunner.step` for substep idempotency (`.start`, `.invoke`, `.end`, `.log` keyed by `round.X.tool.Y.<phase>` so resume skips already-completed phases). `BranchRunner.step` collects interrupts on `b.interrupts` rather than throwing.

Each child's `invoke` in the adapter is:

```ts
invoke: async () => {
  await branchFn(item, branches[i]);
  return branches[i].interrupts ?? undefined;
};
```

If the branch surfaced interrupts (`b.interrupts` set), they bubble up as the invoke's return value; `runBatch` batches them with siblings and stamps the shared checkpoint. Otherwise the invoke returns `undefined` (which `hasInterrupts` reports as not-interrupts, so `runBatch` treats it as success).

The runPrompt outer call site:

```ts
const parallelResult = await pr.parallel(`round.${round}.tools`, toolCalls, keyFor, branchFn);
if (parallelResult.kind === "interrupts") {
  shouldPop = false;
  return parallelResult.interrupts;
}
// continue: parallelResult.kind === "values"
```

`PromptBailout` is still thrown by `PromptRunner.step` (the per-step helper, not by `parallel`); the parallel path returns its result instead of throwing so the `runBatch` `invoke` no-throw-`Interrupt[]` contract is preserved.

### Audit notes for prompt.ts migration

Task 4 of the runBatch plan included a no-throw-`Interrupt[]` audit before the prompt migration. Findings recorded at the top of [`lib/runtime/runBatch.ts`](../../lib/runtime/runBatch.ts):

- `interrupts.ts`, `agencyFunction.ts`, `prompt.ts` body: NO `Interrupt[]` throws.
- `promptRunner.ts`: `PromptBailout` was thrown twice. The `parallel` throw was converted to a return; the `step` throw remains (it's caught by runPrompt's outer try, not by `runBatch`).

Any new `runBatch` adopter should re-run that audit (`grep -nE "throw .*[Ii]nterrupt"`) on its code path before migrating.

---

## Usage guide: writing a new concurrent-interrupt site

Before reaching for `runBatch`, ask: is what you're building actually concurrent execution that may produce multiple interrupts that should share a resume point? If you only have a single interrupt path, you don't need this primitive — write a normal step/handler.

If you do need it, follow this checklist.

### 1. Decide which mode

| You need… | Use mode |
| --- | --- |
| Run N children concurrently; collect every result; batch any interrupts. | `"all"` |
| Run N children strictly in order; batch any interrupts at the end. | `"sequential"` |
| Run N children; first to settle wins; abort losers; recordable resume. | `"race"` |

Examples: fork is `"all"`. Race is `"race"`. Hook-callback batching (Task 6 of the runBatch plan, not yet landed at the time of this doc) is `"sequential"` so the existing `callHook` strict-ordering semantics are preserved — using `"all"` there would silently turn an ordered side-effect chain into a concurrent race.

### 2. Get the parentStack right (this is the only discipline you owe `runBatch`)

`opts.parentStack` MUST be the **local slice** — the branch stack you were handed by the surrounding context, NOT `ctx.stateStack`. This is the discipline that the pre-refactor code got wrong in five different places. `runBatch` enforces everything else (branches, abort, stamping) but it cannot enforce this without knowing your call shape.

If your code is itself running inside a `runBatch` child (i.e., nested), the local slice is the branch stack passed into your `invoke`. If your code is running at the top of a Runner step, the local slice is the `stateStack` arg threaded by the runner.

Pattern (correct):

```ts
private async runMySite(stateStack: StateStack, id: number) {
  const result = await runBatch({
    ctx: this.ctx,
    parentStack: stateStack,            // ← the local slice
    parentFrame: this.frame,
    checkpointLocation: { moduleId: this.moduleId, scopeName: this.scopeName, stepPath: this.stepPath(id) },
    mode: "all",
    children: ...,
  });
}
```

Anti-pattern (wrong, will cause the slice-rule duplication bug):

```ts
parentStack: this.ctx.stateStack,  // ← the global root. DO NOT do this.
```

### 3. Ensure your `invoke` returns rather than throws `Interrupt[]`

`runBatch`'s `invoke` contract:

> MUST RETURN `T | Interrupt[]`. MUST NOT THROW `Interrupt[]`. May throw other errors.

If your code path can today throw an `Interrupt[]` (or an `Error` subclass wrapping one, like `PromptBailout`), convert it to a return before migrating. Otherwise the interrupts bypass `runBatch`'s shared checkpoint stamp and the resume will be broken.

Run the audit on your code path: `grep -nE "throw .*[Ii]nterrupt"` over every file in your call chain. Document the findings (see the comment at the top of `runBatch.ts`).

### 4. Pick stable branch keys

Each child needs a `key` that:

- Is unique within the parent frame's `branches` map.
- Stays stable across resume — pick something derivable from input data, not a counter or random.
- Matches the key your body uses internally (if applicable). The runPrompt tool loop is the cautionary example: `runBatch` allocates a branch under `keyFor(...)`, and `runInvokeStep` in `prompt.ts` separately calls `stack.getOrCreateBranch(branchKey)` — those two MUST produce the same key or you'll get two parallel branches per logical unit and the leaf-checkpoint vehicle will go to the wrong one.

`runBatch` has a defensive `duplicate child key` throw to catch typos, but it can't catch "two different sites used different shapes for the same conceptual branch."

### 5. Decide if you need `recordBranchOutcomes: false`

Almost always **leave it true** (the default). It's what fork and race need.

Set it to `false` only if your `invoke` body manages branch state itself (calls `setResultOnBranch` / `setInterruptOnBranch` / `deleteBranch` inside the body). The runPrompt tool loop is currently the only site that needs this; the comment near that flag's definition in `runBatch.ts` explains why.

If you set it to `false`, you also take on responsibility for body-level idempotency on resume — `branch.result` being set will NOT short-circuit re-invocation. Use a substep-counter machine like `BranchRunner.step`'s `completedSteps` if your body has multiple resumable phases.

### 6. Wire up cost / statelog hooks if you care

The `hooks` field is optional. Don't pass any hooks if your site doesn't track cost or emit statelog events; `runBatch` works fine without them.

If your site does track cost: pass `seedBranchCost` and either `propagateBranchCost` (for mode `"all"`/`"sequential"`) or the pair `propagateLoserCost` + `propagateWinnerCost` (for mode `"race"`). Both branches of the race pair can delegate to the same delta-computing helper; the difference is just the timing (losers eagerly, winner deferred).

If your site emits statelog events: `onBranchStart`, `onBranchEnd(key, idx, outcome, timeMs)`, `onCheckpoint(cpId)` give you the hook points. They fire only for non-cached branches so resume cycles don't re-emit duplicate events.

### 7. Pattern-match the result

```ts
const result = await runBatch({ ... });
if (result.kind === "interrupts") {
  // halt / propagate up; runBatch already stamped the shared checkpoint
  return result.interrupts;
}
// result.kind === "values"
const values: T[] = result.values;
```

Use the tagged union. Do not do `if (Array.isArray(result) && result[0]?.type === "interrupt") ...` — that was the pre-refactor pattern and it was easy to get wrong with mixed shapes.

### 8. Test the four cycles, not just the happy path

Any new site needs at least these tests:

1. All children succeed → returns `kind: "values"`.
2. One child interrupts, others succeed → returns `kind: "interrupts"`; on resume after `respondToInterrupts`, the previously-successful children short-circuit (their `setResultOnBranch` survived), the previously-interrupted child runs once more and succeeds; final result matches the all-succeed case.
3. Multiple children interrupt in the same batch → returns `kind: "interrupts"` with every collected interrupt sharing the same `checkpointId`; one `respondToInterrupts` with N responses resumes them all together. This is the case the `intr.checkpoint` overwrite is designed for and the most common source of subtle bugs in concurrent-interrupt code.
4. Multi-cycle: a previously-interrupted child interrupts AGAIN on its first re-run; another `respondToInterrupts`; everything completes.
5. Mode-specific failure case — for race, a loser was aborted mid-flight; for fork, the rejection-wins-over-interrupts invariant.

The existing `tests/agency/fork/*` suite gives you templates for each.

---

## Slice-only checkpoint composition (still load-bearing)

When the leaf code (`interruptReturn` template at `lib/templates/backends/typescriptGenerator/interruptReturn.mustache`) creates the per-branch checkpoint for a given interrupt, it captures **only its local `__stateStack`** — the branch's own stack. NOT `ctx.stateStack`.

That is critical. If the leaf captured the global root, then when the outer concurrent site serialises a branch's state via `State.toJSON`, it would transplant the global root's snapshot into the branch's slot. The result would be a tree where every branch contains a duplicate of the parent stack from main downward, and on resume `setupFunction` would consume the wrong frames first. Infinite-loop territory.

By capturing only the local stack at every layer, the snapshots compose cleanly:

- Innermost interrupt: captures `[block_frame, function_frame_with_locals]`.
- Fork/race/parallel: stamps that innermost checkpoint onto its sub-branch via `setInterruptOnBranch`. Its own (batch-level) checkpoint captures `[search_frame { branches: { fork_X_i: { stack: <innermost slice>, interruptId, ... } } }]`.
- `runPrompt` (if the concurrent site is inside a tool): stamps the inner checkpoint onto its tool branch. Its own checkpoint captures `[main_frame, runPrompt_frame { branches: { tool_call_*: { stack: <inner slice>, interruptId, ... } } }]`.

`State.toJSON` walks `this.branches` and, when a branch has `branch.checkpoint` set, uses `branch.checkpoint.stack` as that branch's serialised stack — so the inner slice plugs into the outer slot. The final serialised structure mirrors the execution tree top-to-bottom with no duplication.

**The capture sites that must use a local stack (not `ctx.stateStack`):**

- `interruptReturn.mustache` and `interruptAssignment.mustache` — the innermost (leaf).
- **`runBatch`** — uses the `parentStack` opt the caller passed. As long as the caller does its part (passes the local slice — see "Usage guide" step 2), `runBatch` does the right thing. Pre-refactor this discipline lived in five different hand-rolled sites; today it lives in one.

If you ever add a new layer that wraps concurrent execution and stamps checkpoints, just use `runBatch`. Do not hand-roll a parallel `Promise.allSettled` again — the whole point of the primitive is to keep this slice-rule discipline in one auditable place.

---

## Multi-cycle resumes

Branches can interrupt across multiple respond/resume cycles. Common pattern: thread A interrupts and gets approved, then later interrupts again. Meanwhile sibling threads B and C may have completed in cycle 1 and shouldn't replay.

The mechanism: `BranchState.result` and `BranchState.interruptId` survive across cycles via `BranchStateJSON`. On any resume:

- Branch with `result` set → `runBatch` marks it `cached: true` and short-circuits (no `invoke` call, no side effects re-run). Hooks (`onBranchStart`, `onBranchEnd`) also skip cached branches so statelog doesn't double-fire.
- Branch with `interruptId` only → re-invoke `invoke` with the saved stack (deserialise mode). The inner code's frame still has its saved `__interruptId_N` in locals; it looks up the response and either continues or interrupts again.

(When `recordBranchOutcomes: false`, the cached short-circuit is disabled — the body always re-runs and is expected to provide its own substep idempotency. This is the runPrompt tool-loop arrangement.)

This works for arbitrary cycle counts and any mix of completed/interrupted branches.

---

## Race resume (folded into `runBatch`)

Pre-refactor: `Runner.fork` checked `frame.locals[__race_winner_<id>]` at entry. If set, it dispatched to `resumeRaceWinner` instead of `runRace`.

Post-refactor: the caller (`Runner.fork`) unconditionally calls the race adapter. At the top of `runBatch`, if `mode === "race"` and a winner is persisted under `raceWinnerLocalKey`, `runBatch` runs only that child via a single-child path (`runRaceResume` inside `runBatch.ts`). The caller doesn't dispatch.

That single-child resume path:

- Looks up the recorded winner branch.
- If `branch.result !== undefined` → return cached. (Defensive; this path is normally not reached because once a race produces a value, `Runner.fork` advances its step counter and the next call skips the race entirely.)
- Otherwise sets up a fresh `AbortController` (no losers to compose with on resume) and invokes the body. Outcomes are handled the same way as the first-run path (interrupt → stamp shared checkpoint + overwrite; success → record result + `propagateWinnerCost`).

### Multi-cycle race

If the winner interrupts a second time after being approved, `runBatch`'s race-resume path runs again. The body re-enters, advances past the first interrupt site (cached in frame locals), hits the second interrupt site, mints a new `interruptId`, halts. `runBatch` stamps another batch-level checkpoint, overwrites the new interrupt, and returns.

Each subsequent resume keeps re-entering the same winner until it either produces a value or rejection.

---

## LLM tool calls: implementation today

When `llm(prompt, { tools })` is called, the LLM may emit multiple `toolCalls` in a single round. `runPrompt` calls `PromptRunner.parallel` (the thin `runBatch` adapter) with `mode: "all"`, `recordBranchOutcomes: false`, and one child per `toolCall`.

The per-tool branchFn body (in `prompt.ts`):

1. Checks if the handler exists; if not, marks completion and skips.
2. Checks `removedTools`; if blacklisted, marks completion and skips.
3. Allocates the same branch (`stack.getOrCreateBranch("tool_<id>")`) that `runBatch` already created — idempotent.
4. Runs `b.step("…start")` to fire `onToolCallStart`.
5. Runs `b.step("…invoke")` which calls `runInvokeStep` — that's where the handler runs and where `stack.setResultOnBranch` / `setInterruptOnBranch` / `deleteBranch` get called depending on outcome.
6. Runs `b.step("…end")` to fire `onToolCallEnd`.
7. Runs `b.step("…log")` to emit the `toolCall` statelog event.

If any of these `b.step` bodies returns interrupts, `BranchRunner.step` collects them on `b.interrupts`, the rest of the body short-circuits via `if (b.interrupts) return`, and the runBatch child's invoke returns the collected array.

Important rule preserved from the pre-refactor code: **don't `deleteBranch` on a tool success during the parallel loop**. A previous version did, and it broke multi-cycle resumes when one tool succeeded and another interrupted: on resume, the deleted branch had no `existing.result`, so the cached short-circuit didn't fire, and runPrompt re-invoked the tool, pushing a duplicate `toolMessage` to the saved `messagesJSON`. OpenAI then rejected the request with `Duplicate value for 'tool_call_id'`. Branches are cleaned up by `popBranches()` (called by `runBatch` on the no-interrupt success path).

`deleteBranch` IS still called on failure/crash/reject paths inside `runInvokeStep` — that's pre-existing behaviour and is fine because the body subsequently returns and `runBatch` doesn't try to touch the deleted branch (it doesn't `setResultOnBranch` when `recordBranchOutcomes` is false).

### LLM tool calls + fork

When a tool's body contains `fork`, that's the most-nested case the runtime supports. Composition trace:

1. `confirmItem` (innermost function in the fork block) hits `interrupt(...)`. The `interruptReturn` template captures the block-frame stack and stamps it on the interrupt object.
2. The fork block returns the interrupt array. `Runner.runForkAll` (via `runBatch`) sees `hasInterrupts`, calls `setInterruptOnBranch` on the matching `fork_*` sub-branch, and stamps its own batch-level checkpoint (capturing the search-frame slice with its `branches` populated).
3. The search function returns the fork's interrupt array. `runPrompt`'s tool loop (via `PromptRunner.parallel` → `runBatch`) surfaces the interrupts up through the BranchRunner, `runBatch` stamps the tool-level shared checkpoint (capturing the runPrompt-frame slice with its `branches` populated), and the runPrompt body returns the array.
4. The calling node's runner halts; `runNode` returns the array as `result.data`.

On resume, the user's responses are matched by `interruptId`. Each layer's `setupFunction` consumes saved frames in order (StateStack `deserializeMode`); each layer's branches map back to the resumed sub-branches; each layer's invoke re-enters the saved stack; the innermost interrupt site reads its saved `__interruptId_N`, finds the response, continues.

---

## Branch-aware abort signals

Because race needs to actually stop loser work — not just discard the value — the runtime threads an `AbortSignal` per branch.

### Storage

The signal lives on `StateStack.abortSignal`. When `runBatch` creates a branch:

```ts
existing.abortController = new AbortController();
const parentSig = parentStack.abortSignal;
existing.stack.abortSignal = parentSig
  ? AbortSignal.any([parentSig, existing.abortController.signal])
  : existing.abortController.signal;
```

Composing with the parent stack's signal means a nested fork inside a race-loser inherits the loser's abort: when the outer race aborts, every level of nested branch beneath sees the abort.

### Read sites

Three places use the per-branch signal:

- **`Runner.shouldSkip()`** — every step in the runner first checks `this.stack?.abortSignal?.aborted`. If set, the runner halts. The Runner's `stack` opt is set by the `forkBlockSetup.mustache` template to `__forkBranchStack`, so each branch's runner observes its own abort.
- **`ctx.isCancelled(stack)`** — used in `runPrompt` and `interruptWithHandlers` for cancellation checks. Returns true if the global ctx is aborted OR the given stack's signal is aborted.
- **`ctx.getAbortSignal(stack)`** — used in `runPrompt` for the smoltalk HTTP call. Returns a composite `AbortSignal.any([ctx.abortController.signal, stack.abortSignal])`, so when a race loser is mid-LLM-call and the abort fires, the underlying OpenAI SDK cancels the HTTP request and the await throws.

### What this guarantees

When `runBatch` aborts a race loser:

- The loser's `stack.abortSignal` fires.
- The loser's runner halts at the next step (the runner's `shouldSkip()` sees the abort).
- Any in-flight LLM call inside the loser tears down (via the composite signal in `runPrompt`).
- Any tool call inside the loser's `runPrompt` skips new invocations (its per-iteration `ctx.isCancelled(stateStack)` check).
- The global ctx is unaffected — the winner keeps running.

Synchronous code that has already begun executing (e.g., an `interrupt()` call mid-flight) will complete; it can't be unwound. But its resolved value is orphaned (no one awaits it) and gets GC'd.

### Why a stack-based signal instead of AsyncLocalStorage

ALS would make `ctx.aborted` magically branch-aware without any call-site changes — but it's Node-only. Agency is meant to run anywhere TS runs. The stack-based approach requires explicit `stack` args at the sites that check cancellation, but it has no platform dependency and aligns with Agency's pattern of threading state through `stateStack`.

---

## Resume mechanics

`respondToInterrupts(interrupts, responses)` is the public entry point (`lib/runtime/interrupts.ts`):

1. Length-check: `interrupts.length === responses.length` or throw.
2. Build `responseMap: Record<interruptId, response>`.
3. Pull the shared checkpoint off `interrupts[0].checkpoint`. This is the top-level snapshot (e.g., the batch-level cp `runBatch` stamped) — its `.stack` is the full execution tree.
4. Apply any `overrides` to the checkpoint's `globals`/locals.
5. Create a fresh `execCtx` via `ctx.createExecutionContext(runId)`. Call `execCtx.restoreState(checkpoint)`. This replaces `execCtx.stateStack` with `StateStack.fromJSON(...)` and calls `stateStack.deserializeMode()` — which recursively flips every nested branch stack into deserialise mode.
6. Set the response map: `execCtx.setInterruptResponses(responseMap)`.
7. Re-run the entry node via `execCtx.graph.run(nodeName, ...)`.

During the re-run:

- Every `setupFunction`/`setupNode` call to `getNewState()` consumes a saved frame from the front of the deserialise queue.
- Each runner step counter (`frame.step` for top-level, `__substep_X` for nested) skips already-completed steps.
- Each interrupt site reads its saved `__interruptId_N` from `__self.locals` and consults `ctx.getInterruptResponse(id)`.
- Concurrent sites (fork/race/runPrompt tool loop) re-enter `runBatch` which finds the `branches` map already populated: cached results short-circuit, interrupted branches re-run `invoke`.
- Race sites find `__race_winner_<id>` in locals and `runBatch`'s race-resume path re-enters only that index.

If the re-run produces another batch of interrupts, the cycle repeats.

---

## Key files

- [`lib/runtime/runBatch.ts`](../../lib/runtime/runBatch.ts) — the single concurrent-interrupt primitive. Lives next to the adopters; comment at top documents the no-throw audit findings.
- [`lib/runtime/runner.ts`](../../lib/runtime/runner.ts) — `Runner.fork`, `runForkAll` (now adapter), `runRace` (now adapter). The remaining branch-orchestration glue.
- [`lib/runtime/prompt.ts`](../../lib/runtime/prompt.ts) — `runPrompt` and `_runPrompt`. Tool-call branch path.
- [`lib/runtime/promptRunner.ts`](../../lib/runtime/promptRunner.ts) — `PromptRunner.parallel` (now adapter) + `BranchRunner` (per-branch substep idempotency, unchanged).
- [`lib/runtime/state/stateStack.ts`](../../lib/runtime/state/stateStack.ts) — `BranchState`, `BranchStateJSON`, `State.branches`, `setInterruptOnBranch`, `setResultOnBranch`, `deleteBranch`, `popBranches`. Also `StateStack.deserializeMode` and `StateStack.abortSignal`.
- [`lib/runtime/state/context.ts`](../../lib/runtime/state/context.ts) — `RuntimeContext.isCancelled`, `getAbortSignal`, `restoreState`.
- [`lib/runtime/interrupts.ts`](../../lib/runtime/interrupts.ts) — `interrupt()` factory, `interruptWithHandlers`, `respondToInterrupts`.
- [`lib/templates/backends/typescriptGenerator/interruptReturn.mustache`](../../lib/templates/backends/typescriptGenerator/interruptReturn.mustache) — leaf interrupt site. Stamps the leaf checkpoint on the interrupt. **Do not modify** without re-reading the slice-only-capture section.
- [`lib/templates/backends/typescriptGenerator/interruptAssignment.mustache`](../../lib/templates/backends/typescriptGenerator/interruptAssignment.mustache) — same as above but for `let x = interrupt(...)` form.
- [`lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache`](../../lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache) — sets up the per-branch Runner with a `stack: __forkBranchStack` opt so the runner can observe its branch's abort signal.

---

## Invariants worth maintaining

If you change anything in this area, make sure these still hold:

1. **Capture-time slice rule.** Any code that creates a checkpoint inside concurrent execution must capture its **local** `stateStack`, not `ctx.stateStack`. After the runBatch refactor this discipline collapses to: when calling `runBatch`, pass your local slice as `parentStack`. Don't reach for `ctx.stateStack`.
2. **The leaf stamps its own per-branch checkpoint.** Per c72b9c1574, the `isForked`-bypass approach (skipping leaf stamping) was extremely buggy especially for nested forks and nested prompts. Today the leaf always pops + stamps a per-branch checkpoint; `runBatch` reads it and stores it on `BranchState.checkpoint` where `State.toJSON`'s branches walk picks it up. Do not change this.
3. **Don't `deleteBranch` on success during a tool-call loop or fork loop.** Cached `result` must survive across a sibling's interrupt cycle. Cleanup is `popBranches()` after the entire round resolves without interrupts.
4. **`interruptId` is the single source of truth on resume.** The user's responses are keyed by `interruptId` in `responseMap`. The inner code reads it from `__self.__interruptId_N` (saved in frame locals). If the innermost interrupt template ever mints a new id on resume instead of reading the saved one, you'll see fresh ids each cycle and the resume will infinite-loop.
5. **Race deletes loser branches before serialisation.** Loser state must not survive into the checkpoint. Otherwise resume will re-execute losers.
6. **`abortSignal` composes with parent.** Nested branches must inherit ancestor aborts via `AbortSignal.any` so a top-level race abort cascades.
7. **`ctx.isCancelled` and `ctx.getAbortSignal` get the local stack.** Anywhere new in the runtime that wants cancellation awareness must thread the `stateStack` arg, not just `ctx`.
8. **`intr.checkpoint` / `intr.checkpointId` overwrite is intentional.** Every interrupt in a batch deliberately shares one resume point. If you bypass `runBatch` and stamp interrupts yourself, you must also overwrite — otherwise resuming one interrupt won't restore the state needed to resume its siblings.
9. **`runBatch.invoke` must RETURN `T | Interrupt[]`; must not throw `Interrupt[]`.** Run the `grep -nE "throw .*[Ii]nterrupt"` audit on any new call path before migrating.
10. **`raceWinnerLocalKey` shape is checkpoint-format-load-bearing.** The race adapter passes `__race_winner_<id>` — keep that shape. Changing it would silently break any in-flight serialised checkpoints.

---

## Test locations

- Fork basics, multi-interrupt, multi-cycle: `tests/agency/fork/` (top-level files like `fork-multi-interrupt`, `fork-multi-cycle-interrupt`).
- Fork organised by category: `tests/agency/fork/{nested,multi-cycle,control-flow,handlers,llm-tools,race}/`.
- The deepest fork+tool composition: `tests/agency/fork/fork-llm-tool-nested.test.json` (the regression test for the slice-only capture fix).
- Multi-tool batching: `tests/agency/fork/llm-tools/multi-tool-{all-interrupt,mixed,multi-cycle}.test.json`.
- Race + interrupt: `tests/agency/fork/race-interrupt.test.json`, `tests/agency/fork/race/race-{multi-cycle,reject-winner,with-fork-inside,mixed-completion}.test.json`.
- TypeScript-side API: `tests/agency-js/interrupts/{interrupt-approve,interrupt-reject,interrupt-overrides,interrupt-batched-overrides,interrupt-respond-mismatch,interrupt-respond-by-data}/`.
- Fork batching: `tests/agency-js/fork/{fork-parallel-interrupts,fork-nested-interrupts,fork-mixed-responses}/`.
- **`runBatch` unit tests**: `lib/runtime/runBatch.test.ts` — 19 tests covering all three modes, cached short-circuit, abort propagation, race resume dispatch (pending + cached winner), cost-hook asymmetry, empty/duplicate/rejection edge cases, mode-flip defensive assert.
- **`PromptRunner.parallel` unit tests**: `lib/runtime/promptRunner.test.ts` (the `parallel` block) — uses real `State`/`StateStack` to exercise the runBatch path.

---

## Known limitations

- **Race loser cancellation is cooperative.** Synchronous JS code in a loser cannot be interrupted — it runs to completion, but its result is discarded. Cancellation only takes effect at await points and at runner step boundaries.
- **Handler that calls `interrupt()` recursively invokes itself.** See the skipped `tests/agency/fork/handlers/handler-throws-interrupt.test.json`. Whether handler-issued interrupts should bypass the active handler is an open design question.
- **Race + reject of winner**: rejection becomes the race result (a failure `Result`). There's no automatic re-race against the surviving losers — the user must run `race` again at a higher level if they want that semantics.
- **The runPrompt tool loop's `recordBranchOutcomes: false` arrangement is the only current site that opts out of `runBatch`'s branch-state recording.** If a future adopter needs the same arrangement, follow the same pattern (and re-read the comment in `runBatch.ts` explaining why the cached-branch short-circuit is also disabled in that mode).
