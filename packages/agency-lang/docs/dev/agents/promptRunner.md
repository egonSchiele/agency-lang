# PromptRunner

`PromptRunner` (in [lib/runtime/promptRunner.ts](../../../lib/runtime/promptRunner.ts)) is a small control-flow helper used by `runPrompt` ([lib/runtime/prompt.ts](../../../lib/runtime/prompt.ts)). It owns two things:

1. **Idempotent step tracking** for resumable interrupt sites inside `runPrompt`.
2. **Bounded fan-out (`parallel`)** for running multiple tool calls in one LLM round concurrently and merging their interrupts into one shared checkpoint.

It is intentionally separate from `Runner` (the generated-code step engine in [lib/runtime/runner.ts](../../../lib/runtime/runner.ts)). `Runner` is bound to source-map-derived step IDs, codegen-issued moduleId/scopeName, debug/coverage hooks, and the `frame: State` object of a compiled function. `runPrompt` is a TS-runtime function with none of those — `PromptRunner` is the smallest abstraction that fits the use case without forcing `runPrompt` to fake codegen state.

## When a step bails out

A `step()` body returns either `void` (happy path) or `Interrupt[]`. The body returns interrupts when, for example, a tool inside the body collected interrupts from its branches. When the body returns interrupts, `PromptRunner.step`:

1. Snapshots the current messages via the `snapshotMessages` callback supplied at construction time. This snapshot lands on `self.messagesJSON` so the next `runPrompt` invocation can restore it.
2. Creates a checkpoint at `${checkpointInfo.stepPath}/${key}` via `ctx.checkpoints.create(...)` (non-pinned, matching `Runner`'s own interrupt checkpoints in `lib/runtime/runner.ts`). The per-key suffix matters: multiple `step()` calls in one `runPrompt` would otherwise collide on the same `stepPath`.
3. Attaches the checkpoint to every interrupt in the batch and emits a `checkpointCreated` statelog event.
4. Throws `PromptBailout`, which is caught at the top of `runPrompt` and converted to a return value (the interrupts).

The completed-keys list (`self.runnerState.completedSteps`) is **not** updated on bailout. On resume, the step body re-runs. If the user has responded to the interrupt, the tool's saved `__interruptId_N` matches the response and proceeds normally; the step then runs to completion and gets marked done.

## Resume re-runs the code between steps

`runPrompt` does not resume by jumping to the paused step. On resume it
runs again from the top, and every completed step skips its body via
`completedSteps`. The plain code BETWEEN the steps runs again for real:
the round loop, the walk over the round's tool calls, and every inline
`if`. That code must be deterministic. If it reads state that changed
since the first pass, a replayed call can take a path it never took, and
a step that never ran the first time will happily run now.

This has bitten us. The tool loop once refused a call the user had just
approved. Two calls to one tool ran in parallel; one was rejected for
the fifth time, which pushed the tool into `removedTools`; the sibling
paused on its interrupt, and the checkpoint carried the mutation. On
resume, an inline `removedTools.includes(...)` check in front of the
sibling was now true, so the sibling was refused and the approval
discarded. The `removalRace` scenario in `tests/agency-js/tool-rejection`
pins this.

The rule for anything added to `runPrompt`:

1. **Side effects go inside a step.** Anything that must happen exactly
   once — pushing a tool message, firing a hook, bumping a counter —
   belongs in a `step()` body, so a resume skips it.
2. **Decisions that read mutable state also go inside a step, and the
   answer goes into `self.runnerState`.** A step body's return value
   does not survive a skip, so compute the decision once inside a step,
   write it to `runnerState`, and have the code after the step read it
   from there. `runnerState` lives on the frame and is serialized into
   the checkpoint, so a resumed pass reads back exactly the answer the
   first pass recorded.

The tool loop keeps two records of this kind. Both are keyed by
`round.<round>.tool.<slug>`, never by the slug alone: providers like
Gemini return empty tool-call ids, so the same slug repeats across
rounds.

- `runnerState.gateVerdicts` — the refusal-gate verdict for each call
  (removed, unhandled, tooManyRounds, markup, priorRejected, repeated,
  or proceed), computed once in the call's `.gate` step. The gates read
  `removedTools`, `rejectedCalls`, and `repeatStreak`, all of which
  mutate as sibling branches complete.
- `runnerState.invokeOutcomes` — how each invocation ended, recorded
  inside the `.invoke` step. A completed non-success invocation already
  answered the model, so a later pass returns instead of re-entering the
  end and log steps. An interrupted invocation records nothing: its
  invoke step must re-run on resume to consume the user's response.
- `runnerState.handoffStarts` — for a handoff call, the thread length
  right after the `.handoffMarker` step rewrote the tool-call message,
  recorded inside that step. `finishHandoff` strips the body's system
  messages from that index on.

Deterministic reads need no record. Deriving `namedArgs` from
`toolCall.arguments` inline is fine, because the checkpoint restores the
same tool calls.

## `parallel` and merged interrupts

```ts
parallel<T>(
  keyPrefix: string,
  items: T[],
  keyFor: (item: T, index: number) => string,
  branchFn: (item: T, b: BranchRunner, index: number) => Promise<void>,
): Promise<RunBatchResult<void>>
```

`parallel` is a thin adapter over `runBatch` ([lib/runtime/runBatch.ts](../../../lib/runtime/runBatch.ts), documented in [`docs/dev/runtime/runBatch.md`](../runtime/runBatch.md)) with `mode: "all"` and `recordBranchOutcomes: false`. `runBatch` owns the concurrency, the per-branch abort composition, and the shared checkpoint stamped at `${checkpointInfo.stepPath}/${keyPrefix}`. `PromptRunner` supplies the branch bodies and two hooks: `beforeCheckpoint` refreshes `self.messagesJSON` before the checkpoint deep-clones the frame, and `onCheckpoint` emits the `checkpointCreated` statelog event.

Each branch receives a `BranchRunner` whose `step()` **collects** interrupts on `b.interrupts` rather than throwing. Every branch runs to completion, so interrupts surface in one batch. This mirrors `runForkAll`, described in [`docs/dev/runtime/concurrent-interrupts.md`](../runtime/concurrent-interrupts.md).

`parallel` does not throw `PromptBailout`. It returns a `RunBatchResult<void>` tagged union. `runPrompt` checks `parallelResult.kind === "interrupts"` and returns the merged batch directly, which keeps `runBatch`'s no-throw-on-interrupt contract intact.

`keyFor(item, i)` must produce the same branch key the `branchFn` body passes to `stack.getOrCreateBranch(...)`. If the two disagree, `runBatch` allocates a branch separate from the one the body manages, and the leaf checkpoint never reaches `State.toJSON`'s branches walk.

Tool dispatches are not a user-facing concurrency primitive, so `parallel` passes `shareGlobals: true` and `shareThreads: true`. A tool that mutates a global behaves like a normal sequential call.

Inside a `branchFn`, use `b.step(...)`, which collects. Do not use `pr.step(...)`, which throws: a throw from `branchFn` propagates out of `runBatch` and aborts the whole batch.

## `removedTools` / `toolErrorCounts` semantics

`runPrompt`'s tool loop mutates two shared structures from inside concurrent branches: `removedTools` and `toolErrorCounts`. Both live on the frame (`self.removedTools`, `self.toolErrorCounts`) so they survive checkpoint and restore. The design accepts **eventual consistency**. A removal takes effect from the next LLM round, when the `.filter()` after the `pr.parallel` call drops the tool, never within the round where it happened. Within the round, the refusal-gate verdict (see "Resume re-runs the code between steps" above) still refuses a tool already in `removedTools`, but only when that call's `.gate` step runs after the sibling's push. That is best-effort, because the ordering between sibling branches is undefined.

## What `PromptRunner` deliberately is not

- Not a `Runner` replacement. Generated agency code keeps using `Runner` with numeric source-map IDs, debug/coverage hooks, and codegen-derived metadata.
- Not a general TS-runtime step engine. If another runtime helper grows the same needs (resumable steps + checkpoint-on-interrupt), the first move should be extracting a base class from `Runner` rather than copying `PromptRunner`.
- Not a hook firing site. Callback hooks fire via inline `await callHook(...)` (see [`docs/dev/runtime/callback-hooks.md`](../runtime/callback-hooks.md)). Callback bodies cannot raise interrupts (typechecker-enforced), so they don't need PromptRunner's checkpoint-on-interrupt machinery.
