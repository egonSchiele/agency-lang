# `runBatch` — the concurrent-interrupt primitive

`lib/runtime/runBatch.ts` is the single runtime primitive that owns
concurrent-interrupt orchestration. Three callers delegate to it:

- `Runner.runForkAll` — `fork(items) as item { ... }` (mode `"all"`).
- `Runner.runRace`    — `race(items) as item { ... }` (mode `"race"`).
- `PromptRunner.parallel` — parallel tool calls inside `runPrompt`
  (mode `"all"`, `recordBranchOutcomes: false`).

The full architectural context — what BranchState looks like, why the
slice rule exists, how the leaf checkpoint vehicles into the parent's
serialised state — is in
[`docs/dev/concurrent-interrupts.md`](concurrent-interrupts.md). This
doc focuses on the **primitive's API and contracts**.

## Signature

```ts
export async function runBatch<T>(opts: RunBatchOpts<T>): Promise<RunBatchResult<T>>;

type RunBatchResult<T> =
  | { kind: "values";     values: T[] }
  | { kind: "interrupts"; interrupts: Interrupt[] };
```

For the full `RunBatchOpts` field set (`parentStack`, `parentFrame`,
`checkpointLocation`, `children`, `mode`, `raceWinnerLocalKey`,
`recordBranchOutcomes`, `hooks`), read the JSDoc on the type in the
source — it's the canonical reference and stays in sync with the code.

## Three modes

- **`"all"`** — `Promise.allSettled`; every child runs concurrently.
- **`"sequential"`** — `for...of` loop; each child runs after the
  previous resolves.
- **`"race"`** — `Promise.race`; first to settle wins, losers get
  `abortController.abort()` and their branches are deleted. Resume
  dispatch is folded in: if `raceWinnerLocalKey` holds a number, only
  the winner re-runs.

### Sequential mode

`"sequential"` is currently unused by any caller — `Runner.hook` was
the previous user and was removed when callback-interrupt propagation
was deleted. The mode is preserved for callers that want ordered side
effects with shared batch-checkpoint semantics.

## The slice rule (caller contract)

`opts.parentStack` MUST be the **local slice** that the caller is
holding (e.g. the branch stack you were handed if `runBatch` is itself
called inside a child of an outer `runBatch`), NEVER `ctx.stateStack`.
The shared batch-level checkpoint stamps from this stack; passing the
wrong slice yields a checkpoint that captures the wrong frame chain
and silently breaks resume.

This is the **one** discipline `runBatch` callers must observe. Every
existing adapter (`runForkAll`, `runRace`, `PromptRunner.parallel`)
gets this right; review any new adapter against the slice rule before
merging.

## The `invoke` no-throw contract

Each `BatchChild.invoke` MUST RETURN `T | Interrupt[]` and never THROW
an `Interrupt[]`. Other JS errors may be thrown — `runBatch` rethrows
the first one it sees and abandons any interrupts that sibling
branches collected (the rethrown error wins; callers that need both
must catch inside `invoke`).

A pre-Task-4 audit (recorded at the top of `runBatch.ts`) found one
violation site: `PromptBailout` throws inside `promptRunner.ts`. Those
were converted to returns when `runPrompt`'s tool loop migrated.
Future adopters should re-run the audit on their code path
(`grep -nE "throw .*[Ii]nterrupt"`).

## Defensive guards

- **Duplicate child key.** `runBatch` validates `children[*].key`
  uniqueness up front and throws a clear error if two children share
  a key. Same key would clobber the branch state.
- **Mode-flip mismatch.** If `parentFrame.locals[raceWinnerLocalKey]`
  is set but `mode !== "race"` (or vice versa), `runBatch` throws.
  Catches caller bugs where a frame previously ran a race batch and
  was then re-entered with a different mode.

## `recordBranchOutcomes`

Default `true`: `runBatch` records the per-branch outcome via
`setResultOnBranch` (success) or `setInterruptOnBranch` (interrupt).
This is what fork / race / hook need.

`false`: the caller's `invoke` is responsible for managing branch
state itself (via `stack.setResultOnBranch` / `setInterruptOnBranch`
inside the body). `runBatch` still stamps the shared checkpoint and
overwrites `intr.checkpoint`/`checkpointId`, but does NOT touch
BranchState fields. `runPrompt`'s tool loop sets this because the
body manages the real tool result on the branch (see
`docs/dev/concurrent-interrupts.md` for the longer rationale).

When this flag is false, `runBatch` also disables the
cached-branch short-circuit — `branch.result` being set no longer
means "the body is fully done." Idempotency is the caller's
responsibility.

## `isolateState` (per-branch globals + active-thread)

Default `true`: each child runs inside its own ALS frame seeded with a
clone of the parent's `GlobalStore` and a fresh active-thread pointer
(`forkBranchView`). Branches see/mutate their own state; siblings and
the parent are invisible. On a clean return, the per-branch state is
captured to `BranchState.globalsJSON` and `BranchState.activeStack`
so it survives serialization through an interrupt and is restored
on resume (via `GlobalStore.fromJSON` + `ThreadStore.restoreBranchView`).
This is what `fork` / `parallel` / `race` use by default.

`false`: the branch's ALS frame pointer-shares the parent's
`GlobalStore` and `ThreadStore`. Used by `runPrompt`'s tool-dispatch
loop because tool calls are conceptually sequential function
invocations and any global state they touch (counters, retry budgets,
dedup caches) should accumulate across calls. No per-branch capture
either — nothing to snapshot.

Users can opt into shared state at the call site via `shared: true`
(parsed by `parallelDesugar`, plumbed through `processForkCall`), which
threads `isolateState: false` into the `runBatch` call.

Implementation lives in `runInBranchAlsFrame` (top of `runBatch.ts`):
it picks the seed values, installs the frame with `agencyStore.run`,
and (when isolated) wraps the body in capture-on-return logic that
writes `globalsJSON` / `activeStack` after the body settles —
including settling-as-`Interrupt[]`. Errors skip the capture (error
branches are torn down, not resumed).

## What `runBatch` deliberately does NOT touch

Per commit `c72b9c1574` (which removed the buggy `isForked` approach
that broke nested-fork composition):

- The leaf `interruptReturn` template still stamps a per-leaf
  checkpoint. `runBatch` reads it off each surfaced `Interrupt` and
  writes it to `BranchState.checkpoint` — the leaf checkpoint is the
  vehicle that carries the pre-pop branch stack into
  `State.toJSON`'s branches walk.
- Per-branch handler chains (`handle` blocks) — safety-critical and
  must not be skipped.
- The `__race_winner_<id>` key shape — preserved deliberately for
  in-flight checkpoint compatibility.

## Subprocess-shape (future)

`runBatch`'s shape — per-child branch, idempotent re-entry,
shared-checkpoint batching — is the same shape that a subprocess /
multi-process executor would need. A future "spawn agent in
subprocess" adapter would build its `BatchChild.invoke` around an
IPC round-trip rather than a synchronous function call, surface the
subprocess's interrupts as the return value, and otherwise reuse the
existing branch lifecycle / checkpoint stamping unchanged. Designing
that adapter is out of scope here; see
`docs/superpowers/specs/2026-05-09-subprocess-propagation-and-resume-design.md`
for the broader subprocess plan.
