# PromptRunner

`PromptRunner` (in [lib/runtime/promptRunner.ts](../../lib/runtime/promptRunner.ts)) is a small control-flow helper used by `runPrompt` ([lib/runtime/prompt.ts](../../lib/runtime/prompt.ts)). It owns two things:

1. **Idempotent step tracking** for resumable interrupt sites inside `runPrompt`.
2. **Bounded fan-out (`parallel`)** for running multiple tool calls in one LLM round concurrently and merging their interrupts into one shared checkpoint.

It is intentionally separate from `Runner` (the generated-code step engine in [lib/runtime/runner.ts](../../lib/runtime/runner.ts)). `Runner` is bound to source-map-derived step IDs, codegen-issued moduleId/scopeName, debug/coverage hooks, and the `frame: State` object of a compiled function. `runPrompt` is a TS-runtime function with none of those — `PromptRunner` is the smallest abstraction that fits the use case without forcing `runPrompt` to fake codegen state.

## When a step bails out

A `step()` body returns either `void` (happy path) or `Interrupt[]`. The body returns interrupts when, for example, a tool inside the body collected interrupts from its branches. When the body returns interrupts, `PromptRunner.step`:

1. Snapshots the current messages via the `snapshotMessages` callback supplied at construction time. This snapshot lands on `self.messagesJSON` so the next `runPrompt` invocation can restore it.
2. Creates a checkpoint at `${checkpointInfo.stepPath}/${key}` via `ctx.checkpoints.create(...)` (non-pinned, matching `Runner`'s own interrupt checkpoints in `lib/runtime/runner.ts`). The per-key suffix matters: multiple `step()` calls in one `runPrompt` would otherwise collide on the same `stepPath`.
3. Attaches the checkpoint to every interrupt in the batch and emits a `checkpointCreated` statelog event.
4. Throws `PromptBailout`, which is caught at the top of `runPrompt` and converted to a return value (the interrupts).

The completed-keys map is **not** updated on bailout. On resume, the step body re-runs. If the user has responded to the interrupt, the tool's saved `__interruptId_N` matches the response and proceeds normally; the step then runs to completion and gets marked done.

## `parallel` and merged interrupts

`PromptRunner.parallel(keyPrefix, items, branchFn)` runs `branchFn` for every item concurrently via `Promise.all`. Each branch receives a `BranchRunner` whose `step()` **collects** interrupts on `b.interrupts` rather than throwing. After all branches settle, `parallel` merges their interrupts (if any) into one `PromptBailout` and stamps a single checkpoint at `${checkpointInfo.stepPath}/${keyPrefix}`. The semantic mirrors `runForkAll` in `docs/dev/concurrent-interrupts.md`: siblings always run to completion so interrupts surface in one batch.

Inside a `branchFn`, use `b.step(...)` (collects) — not `pr.step(...)` (throws). A throw inside `Promise.all` propagates out of `parallel` uncaught.

## `removedTools` / `toolErrorCounts` semantics

`runPrompt`'s tool loop mutates two shared structures from inside concurrent branches: `removedTools` and `toolErrorCounts`. The plan accepts **eventual consistency**: removals always take effect from the next LLM round (the `.filter()` after the `pr.parallel` call), never within the round they happened. Within the round, a "gated start" check in each branch's first step still skips a tool already in `removedTools` — best-effort, ordering between sibling pushes is undefined.

## What `PromptRunner` deliberately is not

- Not a `Runner` replacement. Generated agency code keeps using `Runner` with numeric source-map IDs, debug/coverage hooks, and codegen-derived metadata.
- Not a general TS-runtime step engine. If another runtime helper grows the same needs (resumable steps + checkpoint-on-interrupt), the first move should be extracting a base class from `Runner` rather than copying `PromptRunner`.
- Not a hook firing site. Callback hooks fire via inline `await callHook(...)` (see [`docs/dev/callback-hooks.md`](callback-hooks.md)). Callback bodies cannot raise interrupts (typechecker-enforced), so they don't need PromptRunner's checkpoint-on-interrupt machinery.
