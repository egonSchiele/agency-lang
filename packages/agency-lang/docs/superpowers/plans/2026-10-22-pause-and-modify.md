# Plan: pause and modify, editing a paused program before it resumes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person or an agent, stopped anywhere in a run or holding a
checkpoint file, can make a small named change to the paused program
(append a message to a thread first of all) and resume it.

**Architecture:** A pure patch library in the runtime turns a list of
edits as data into a new signed checkpoint or a list of refusals; every
resume path takes that list, and the old resume overrides become sugar
over it. The debugger anchors each edit to a pane row through one action
table, which also generates the `agency debug session edit` verbs.

**Tech Stack:** TypeScript, zod for the edit schemas, the existing TUI
(`lib/tui/`), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-21-pause-and-modify.md`.
Linear: ADI-12, with one ticket per PR below once the spec is reviewed.

Three PRs against `main`, each reviewed on its own and each useful alone.
PR 1 is the patch library and the resume paths taking edits; after it a
TypeScript host can make every edit in the spec on a checkpoint it holds.
PR 2 puts the first edit on the debugger's rows and on the session CLI;
after it the motivating run can be told to stop researching. PR 3 adds
the other rows, the palette, `agency resume --edit`, and the serve route.
Smoke the built binary after each PR against a real `agency run` in
another terminal, not only the tests.

Reading before starting: the spec; `docs/dev/runtime/checkpointing.md`,
`rewind.md`, `resume-command.md`, and `checkpoint-integrity.md`;
`docs/dev/agents/promptRunner.md`, "Resume re-runs the code between
steps"; `docs/dev/cli/debugger.md`, "Stops between tool calls" and the
key table; `docs/dev/cli/debugger-attach.md` and `debugger-session.md`
whole; `docs/dev/cli/debugger-tests.md`; `docs/dev/evals/eval-new.md`,
"One table defines a field", the precedent for a table the UI reads.

## Global constraints

- Objects, not maps; arrays, not sets; `type`, not `interface`; no
  dynamic imports (`CLAUDE.md`).
- A checkpoint is never changed in place. Every edit path copies,
  changes, validates, re-signs when the source was signed.
- No edit writes a control or identity field (the field-kind table in
  the spec). The validator refuses the path; no caller may bypass it.
- No form or verb asks for a thing the checkpoint already knows: a thread,
  a guard, a local, a tool, a branch is the row the cursor is on or a
  choice flag with the row's options.
- A root budget takes no guard edit; `reinstallRootBudget` would undo it.
- `set-branch-result` applies to fork and parallel branches only; a
  `tool_*` branch is refused.
- The debugger's two refusals of `set` (branch stack, loop stop) are
  removed by PR 1, not worked around.
- Handlers are not serialized; every path here resumes through
  `restoreForResume`, which reinstalls them. No new resume loop.
- Run the tests that cover the files you changed locally, saving the
  output to a file (`pnpm test:run <paths> > out.txt 2>&1`); leave the
  full agency suite to CI (`CLAUDE.md`). Typecheck with `pnpm run
  typecheck`, format with `pnpm run fmt:ts`, and run `pnpm run
  lint:structure` before each push.

## Review focus

Inputs the spec implies and no section below names a test for, each
pinned to the task that owns the code:

1. A thread label that names two threads (two subagents both labelled
   `search`): the address refuses with both ids. PR 1, addresses.
2. An `appendMessage` with an empty string or a non-string `text` from
   the HTTP body: refused by the zod schema before any checkpoint is
   read. PR 1, the edit schema.
3. A `setGuard` on a time guard whose branch clone has already elapsed
   more than the new limit: the validator refuses as "would trip at
   once" rather than writing a negative remaining time. PR 1, validator.
4. `Ctrl+C` or Escape with text in the composer: the draft is kept, not
   sent and not lost, and quitting asks first as the eval form does.
   PR 2, the composer.
5. A visit queues an edit, its process exits, and a second visit
   continues: the edit still applies, since the driver holds it. PR 2,
   `commands.test.ts` and `index.test.ts`.

## What is already there

`Checkpoint` (`lib/runtime/state/checkpointStore.ts`) is the reader every
pane and every session verb goes through. Its resolvers are the address
layer this plan needs: `stackAt(branchPath)`, `framesAlong(branchPath)`,
`shownFrame(location)`, `listThreads`, `getThreadMessages`,
`listBranches`, `listGuards`, `loopState`, and two private ones,
`threadsAlong(branchPath)` (which pairs a store thread with the newer
copy a tool loop holds in `messagesJSON`) and `branchActiveStack`.
`Checkpoint.clone(opts, settings)` is the copy-and-re-sign idiom; `fromJSON`
validates with `checkpointSchema` (`lib/runtime/state/schemas.ts`).

Writing is in `lib/runtime/resumeSetup.ts`: `applyLocalOverrides(source,
overrides, settings)` deep-clones, writes `locals` on the root stack's
last frame, re-signs; `restoreForResume` writes `args` the same way and
globals into the live store after restore; `checkedOverrides` refuses
`__proto__`. `rewind.ts` exports `applyOverrides` as a thin wrapper and
`rewindFrom({ ctx, checkpoint, overrides, ... })`. `interrupts.ts` has
`respondToInterrupts`, `respondToInterruptsForServe`, and
`resumeFromCheckpoint`, all taking `overrides` and all ending in
`restoreForResume`. `portable.ts` re-exports `applyLocalOverrides`,
`applyRestoreOverrides`, `restoreForResume`; the generated module exports
`rewindFrom` through `lib/templates/backends/typescriptGenerator/imports.mustache`.

The tool loop's stops and queue: `PromptRunner.llmCall` stops before a
request (`loopStop: "round"`) and `beforeToolCall` before a call
(`loopStop: "tool"`), in `lib/runtime/promptRunner.ts`. The round
boundary in `lib/runtime/turnBoundary.ts` (`runRoundBoundary`) delivers
`queuedMessages` after every tool result and before the next request
step, so a queued message always lands between a round's results and the
next request. On resume, `prompt.ts` rebuilds the loop's thread from
`self.messagesJSON` through `restoreThreadForResume` (`threadRepair.ts`),
which adopts it into the store's thread. The loop's removed tools are
`self.removedTools`, a local of the `runPrompt` frame, filtered out at the
round boundary, so a removal takes effect from the next round; the
calls the model already made this round still run. The loop's tool list
is `args.clientConfig.tools`, an argument and not a frame local, so no
checkpoint today records which tools a loop was offered. The
`runPrompt` frame's other locals (`toolCallRound`, `pendingToolCalls`,
`rejectedCalls`, `rejectionCounts`, `repeatStreak`, `toolErrorCounts`,
`validationAttempt`, `__initialized`, `runnerState`) are the loop's
bookkeeping, and a user function may have a local of any of those
names.

When several branches stop at once, `runBatch` stamps one shared
checkpoint at the batch's location onto every interrupt in the batch
(`docs/dev/runtime/concurrent-interrupts.md`, "Shared checkpoint stamp"),
so that checkpoint's `branchPath` and `loopStop` are the batch's, and
the stop a person is looking at has its own location only in the stop
record (`stopOf(interrupt)` in `driver.ts`).

The generated wrappers in `imports.mustache` copy each option by name
(`overrides: opts?.overrides, metadata: opts?.metadata, ...`) into
`__ResumeOptions`, `__RewindOptions`, `__ResumeFromCheckpointOptions`,
and `ServeResumeOptions`; `resumeFromCheckpoint` takes no overrides
today; `agency resume` enters through the private `__resumeFromCheckpoint`
into `_resumeCliFromCheckpoint`; and the driver calls the module's
`rewindFrom` positionally, `(checkpoint, overrides, options)`. An
in-program `restore(cp, { globals })` reaches `applyRestoreOverrides`
through `applyRestoreSignal`, on every run loop.

Guards: `GuardJSON` (`lib/runtime/guard.ts`) carries `guardId`, `label`,
`disarmed`, `isRootBudget`, and `costLimit`/`spent` or
`timeLimit`/`elapsedMs`. A branch stack serializes inherited time clones
in `inheritedTimeGuards` and `rehydrateInheritedGuardsFrom`
(`stateStack.ts`) adopts them by `guardId` on resume; cost clones are
rebuilt from the parent. `reinstallRootBudget` (`rootBudget.ts`) resets a
root guard's limits from the host on every resume.

The debugger: `DebuggerDriver` (`lib/debugger/driver.ts`) keeps
`pendingOverrides`, fills it from the `set` command, hands it to
`respond` as `{ overrides }` on the next resume and to `rewindFrom` on a
rewind, and tells the UI through `DebuggerIO.setOverrides`. The UI
(`ui.ts`) draws panes from `getPanes()`, one `build…Content()` per pane,
scrolls a focused pane with `↑`/`↓` (`scrollPane`), and shows overlays
from `overlays.ts` (`showGuardTripForm` is the one-line form precedent:
a prompt, a line editor through `lineEditAction`/`applyLineEdit`, Escape
cancels, a refused value restarts the field with the reason). `uiState.ts`
holds the checkpoint, the stop, and the branch path. Over the channel,
`DebuggerCommand` has a zod schema in `attach/protocol.ts` with a
`SameShape` check; notices named in `SETTING_METHODS`
(`attach/sessionRules.ts`) are replayed to a joining party. The session
CLI (`lib/cli/debugSession/`) has `set` in `commands.ts`, built on
`sameStop`, which answers the stop with a command and reads the redraw.

Tests: `lib/runtime/checkpointTestHelpers.ts` builds a one-frame
checkpoint by hand; `lib/debugger/testSession.ts` drives the real UI
headlessly (`press`, `type`, `frame()`); `agentShaped.test.ts` runs the
tool loop against `withLLMMocks` scripted replies on
`tests/debugger/agent-shaped.agency`, which has a loop with three tools, a
subagent thread, and an interrupt; `guard-trip.agency` has a labelled
cost guard; `fork-test.agency` has a fork with a breakpoint in each
branch.

## Where the imperative code lives

Two places tempt a handler full of branches, and both are kept as data
plus one pure function.

**The edits.** Each edit lowers to one or more writes at a JSON path,
and the field-kind table says what a path may be. The first draft of
this would be a `switch` over `op` that reaches into the checkpoint. The
plan instead has `resolve(edit, checkpoint): Write[] | Refusal`, pure,
returning the paths and values, and one `applyWrites` that checks each
path against the kind table and writes it. Every edit is then readable
as "which paths, which values", and the validator runs on the result
with no knowledge of which edit produced it.

**The rows.** The UI could grow a `case` per pane per key. The plan has
`EDIT_ACTIONS` as data, `rows.ts` turning a checkpoint and a stop into
the rows each pane shows (with the address each row carries), and one
lookup, `actionsFor(row)`, that the key handler, the footer, the palette,
and the CLI verbs all call. Adding an edit is a record in one file.

## PR 1. The patch library (ADI-12a)

No UI. After this PR: `patchCheckpoint` exists and is exported from
every compiled module; `rewindFrom`, `resumeFromCheckpoint`,
`respondToInterrupts`, and `respondToInterruptsForServe` accept `edits`;
the three override shapes produce the same checkpoint as the equivalent
edits; the debugger's `set` works on a branch stack and at a loop stop.

### Files

New, in `lib/runtime/state/checkpointPatch/` (a feature directory, one
concept per file):

- `edits.ts`: the `CheckpointEdit` union, the address types, and their
  zod schemas (`checkpointEditSchema`, `checkpointEditsSchema`), with a
  `SameShape` check against the types as `protocol.ts` does.
- `addresses.ts`: `resolveFrame`, `resolveLoopFrame`, `resolveThread`,
  `resolveBranch`, `resolveGuard`, `resolveModule`, each
  `(address, checkpoint) => Located<T> | Refusal`. `Located<T>` is
  `{ path: string[]; found: T }`, and the path comes from the reader's
  locator (below), never spelled here.
- `fieldKinds.ts`: `fieldKind(path: string[], scopeName: string | null): "data" | "control" | "identity"`,
  the one table, as a list of path patterns. A path alone cannot say
  whether a local is data, since the `runPrompt` frame keeps its
  bookkeeping in locals and a user function may use the same names. So
  the table is by frame: in a `runPrompt` frame the data locals are an
  allow list, `messagesJSON.messages`, `messagesJSON.queuedMessages`,
  `removedTools`, and every other local is control; in any frame a
  segment starting with `__` is control
  (`docs/dev/language/reserved-names.md`); `step`, `nodesTraversed`,
  `deserializeStackLength`, `mode`, a guard's `spent` and `elapsedMs`
  are control; ids, fingerprints, `signature`, `traceId` are identity.
- `lower.ts`: `resolve(edit, checkpoint): Write[] | Refusal`, one case per
  `op`, each a few lines that pick a locator and a value, and
  `type Write = { path: string[]; value: unknown; applied: string }`.
  The two decisions with any logic in them are their own pure
  functions with their own tests: `messageLanding(thread): "messages" | "queued"`
  and `guardWrites(copies: GuardCopy[], change): Write[]`.
- `validate.ts`: `VALIDATION_RULES: ValidationRule[]`, one record per
  invariant, `type ValidationRule = { name: string; check: (json: CheckpointJSON) => string | null }`,
  and `validate(source: CheckpointJSON, result: CheckpointJSON): Refusal[]`
  that runs the table on both and keeps a rule's refusal only when the
  rule passes on the source.
- `index.ts`: `patchCheckpoint(source, edits, settings)` and the result
  types; `fromOverrides(overrides: ResumeOverrides, checkpoint): CheckpointEdit[]`.

One `Refusal` type for the whole directory, `{ refused: string }`, and
every function that can refuse returns a union with it, as
`patchCheckpoint` does.

Changed: `checkpointStore.ts`. The reader class gains locators, so the
checkpoint's layout stays in the one file that knows it today and the
patch directory never spells a path. The readers do not keep paths
today: `framesAlong` flattens every stack on the way into one list, and
`threadsAlong` works from that list, so a view cannot say which frame it
came from. So the change is one walker, `walkFrames(branchPath):
{ frame: StateJSON; path: string[] }[]`, every frame along the branch
path with its JSON path, and `stackAt`, `framesAlong`, and
`threadsAlong` rebuilt on it. Each reader then keeps its return and
gains a `path` beside what it finds: `ThreadView` (and `threadsAlong`,
public now) carries the path of the messages list it shows, which is
the list a resume reads: the loop copy's when the frame holds one, the
store's otherwise, and for a loop inside a tool call, whose store is
not serialized, the loop copy's alone (there is no store entry to fall
back to). A `messagesJSON` that is a bare array, the shape of an older
checkpoint, is read by `toolCallName` and ignored by `loopThreadCopy`
today; the walker treats it as a thread with no labels and the edit
writes it back as the full `MessageThreadJSON`, the shape every write
produces. `listGuards` returns each guard with `paths`, the owning
copy's and every clone's along the branch path (from
`inheritedTimeGuards` on each stack the walker passes); `listBranches`
returns each branch with its `path`; `loopState` returns the loop
frame's `path` and its `tools` (below); `globalsAt(branchPath)` returns
its `path` too, the root's `globals.store` or the branch's
`globalsJSON.store`. `messageLanding(thread)` lives beside
`threadsAlong`, since it reads what that reader reads.

`prompt.ts`: `runPrompt` sets one new frame local at init,
`self.toolNames = rawTools.map((t) => t.name)`, so a checkpoint records
which tools the loop was offered; `loopState` reads it as `tools`, and
an older checkpoint without it gives `tools: null`.
`resumeSetup.ts`, `rewind.ts`, `interrupts.ts`, `portable.ts`,
`imports.mustache`, `driver.ts` (the two refusals go), `schemas.ts` if a
field is missing from it (none expected; check `queuedMessages` is in
`messageThreadJSONSchema`).

### The edits

```ts
export type FrameAddress =
  | { branchPath?: string[]; depth?: number }
  | { branchPath?: string[]; scope: string };
export type LoopAddress = { branchPath?: string[] };
export type ThreadAddress = { id: string } | { label: string } | { active: true };
export type BranchAddress = { path: string[] } | { key: string };
export type GuardAddress = { label: string } | { index: number };
export type ModuleAddress = { module?: string };

export type CheckpointEdit =
  | { op: "appendMessage"; thread?: ThreadAddress; role?: "user" | "assistant"; text: string }
  | { op: "removeTool"; loop?: LoopAddress; tool: string }
  | { op: "setGuard"; guard: GuardAddress; branchPath?: string[]; limit?: number; disarmed?: boolean }
  | { op: "setLocal"; frame?: FrameAddress; name: string; value: unknown }
  | { op: "setBranchResult"; branch: BranchAddress; value: unknown }
  | { op: "setArg"; frame?: FrameAddress; name: string; value: unknown }
  | { op: "setGlobal"; module?: string; name: string; value: unknown };
```

An omitted address means the stop's own: the checkpoint's `branchPath`
and `shownFrame` for a frame, the active thread, the last loop frame on
the checkpoint's stack. `text` is `z.string().min(1)`; `name` is the
Agency identifier pattern `resumeOverrides.ts` uses, and never a
prototype key (review focus 2).

### The addresses

Each resolver returns `{ path: string[]; found: T }` or
`{ refused: string }`. Rules, each a test row:

- `resolveFrame`: `depth` counts from the end of `stackAt(branchPath)`,
  0 the last frame; `scope` is the nearest frame with that `scopeName`
  from the end; a `branchPath` the checkpoint does not hold refuses
  "no branch at <path>". With neither `depth` nor `scope`, `shownFrame`
  at the checkpoint's own location.
- `resolveLoopFrame`: `loopState`'s rule, the same function: the last
  frame along the whole branch path (`walkFrames`, not one stack) whose
  `scopeName` is `runPrompt` and whose `toolCallRound` is set, since at a
  stop inside a tool call the loop is on the parent's stack; none
  refuses "no tool loop above this stop".
- `resolveThread`: `threadsAlong(branchPath)`; `{ active: true }` is the
  view with `active`; `{ label }` matching two views refuses naming both
  ids (review focus 1). The path is the one the reader hands back.
- `resolveBranch`: `{ key }` searched through `listBranches`; two
  matches refuse with both paths; a `tool_` key refuses for
  `setBranchResult` only (the resolver returns it; `lower.ts` refuses).
- `resolveGuard`: `listGuards(branchPath)`; by label, two matches refuse
  with both indices; returns the guard with its `paths`.
- `resolveModule`: `globalsAt(branchPath)`, so a stop inside a fork or
  parallel branch resolves to the branch's own copy of the globals, the
  one the branch reads, and the root otherwise; the checkpoint's
  `moduleId` when the module is omitted; a module not in that store
  refuses.

### Lowering

`resolve(edit, checkpoint)` per `op`:

- `appendMessage`: `messageLanding(thread)` says which list. `"queued"`
  when the thread's last message is an assistant message with `toolCalls`
  that the messages after it do not all answer: the write appends
  `{ role, content: text, label: null }` (a `QueuedMessage`) to the
  thread's queue, applied line "queued on thread <name>, delivered after
  N pending tool results". `"messages"` otherwise: the write appends a
  smoltalk `MessageJSON` with the role and a text part, applied line
  "appended to thread <name> (<count> messages)". The function reads
  the thread, not the stop kind.
- `removeTool`: the loop's removed-tools list plus the name, unless
  already there. A name not in `loopState().tools` refuses "no tool
  <name> in this loop"; a checkpoint from before `toolNames` (`tools:
  null`) accepts any name. The applied line is "removed <name> from the
  next round", since the round boundary applies the list and a call the
  model already made this round still runs.
- `setGuard`: a root budget refuses "<label> is the root budget; the host
  sets its ceiling". The rest is `guardWrites(copies, change)`, pure,
  over the `GuardCopy[]` the reader returns (`{ path, json, owner:
  boolean }`): `disarmed` is one write per copy; `limit` on a cost guard
  is one write to the owner's `costLimit`; `limit` on a time guard is a
  write to the owner's `timeLimit` and, for each clone, its `timeLimit`
  plus `(limit - owner.timeLimit)`.
- `setLocal`, `setArg`: the frame's local or arg of that name.
- `setBranchResult`: the branch's `result` becomes `{ result: value }`; a
  `tool_` key refuses "a tool call's result is loop bookkeeping; see the
  spec's not goals"; a branch with `interruptId` and no `result` refuses
  "branch <key> is waiting on interrupt <id>".
- `setGlobal`: the module's global of that name, in the store
  `resolveModule` found (`globals.store[module][name]` at the root,
  `branches[key].globalsJSON.store[module][name]` inside a branch).

`applyWrites(json, writes)` checks `fieldKind(path, scopeName)` is
`data` for every write before writing any, with `scopeName` read from
the frame the path passes through, and refuses the first that is not.

### The validator

`VALIDATION_RULES` is one record per invariant, and `validate(source,
result)` runs the table on both and returns a refusal, prefixed with the
rule's name, for each rule that holds in the source and fails in the
result. The source decides what counts: the checkpoints the debugger
stops on already break two of the rules (a guard-trip stop has a guard
over its limit, and a tool stop has a thread ending in unanswered tool
calls), and an edit that touches neither must go through. A rule is a
record and a test row, in the spec's words:

- a thread ending in an unanswered assistant tool call with no running
  `tool_` branch for it;
- a guard with `spent > costLimit` or `elapsedMs > timeLimit` and not
  `disarmed` ("would trip at once"; review focus 3);
- `checkpointSchema.safeParse` failing, with zod's message (checked on
  the result alone, since the source parsed to be a `Checkpoint`).

No rule about `step`: no edit in this spec can write it, since
`fieldKind` refuses the path, so there is nothing for a source-map rule
to catch, and the parameter it would need goes with it. The spec that
adds jump edits adds both.

`patchCheckpoint` runs `resolve` for every edit (collecting refusals),
then `applyWrites` on a `deepClone` of `source.toJSON()`, then
`validate(source, result)`, then `Checkpoint.fromJSON`, then
`signCheckpoint(copy, settings)` when `source.signature !== undefined`.
Any refusal returns `{ refused }` and no checkpoint.

### The overrides become edits

`fromOverrides(overrides, checkpoint, at?)` maps `locals` to `setLocal`
with `frame: { branchPath, loopStop }`, `args` to `setArg` the same way,
`globals` to `setGlobal` with the same `branchPath`. `at` is the stop's
own location when the caller has one (the debugger; see "The driver" in
PR 2) and the checkpoint's otherwise. This moves the overrides to a
different frame than today: `applyLocalOverrides` writes the root
stack's last frame whatever the checkpoint's `branchPath`, and under
`fromOverrides` a local override on a checkpoint taken inside a tool
call lands on the tool's frame, and at a loop stop on the frame that
called `llm()` (`shownFrame`). That is the frame a person means, and it
changes what `agency resume --local-var` does on such a checkpoint; the
PR description and `resume-command.md` say so, and a test pins the new
frame on a branch checkpoint.

`applyLocalOverrides` keeps its signature and its body becomes
`patchCheckpoint(source, fromOverrides({ locals: overrides }, source),
settings)`, throwing `CheckpointEditError` (new, in `errors.ts`,
carrying `refusals`) on refusal, so its existing callers and tests keep
their contract (the `__proto__` test's message changes to the
validator's; update the assertion). `restoreForResume` takes `edits?:
CheckpointEdit[]` on `ResumeRequest`, builds
`[...fromOverrides(overrides, checkpoint), ...edits]`, and patches once;
the args write it did itself goes, and the globals override is written
into the checkpoint's store rather than the live one. `rewindFrom`,
`respondToInterrupts`, `respondToInterruptsForServe`,
`resumeFromCheckpoint` (which takes no overrides today), and
`resumeCliFromCheckpoint` gain `edits?` and pass it through.

`applyRestoreOverrides` keeps both its branches. `applyRestoreSignal`
calls it for an in-program `restore(cp, { globals })` on every run
loop, and that path keeps writing the live store as it does today; a
test of `restore` with `globals` is added to pin it. Only
`restoreForResume` stops calling it for globals.

Exports: `patchCheckpoint`, `CheckpointEdit`, `CheckpointEditError` from
`portable.ts`. In `imports.mustache`, `patchCheckpoint` beside
`rewindFrom`, and `edits?: CheckpointEdit[]` added to `__ResumeOptions`,
`__RewindOptions`, `__ResumeFromCheckpointOptions`, and
`ServeResumeOptions`, each wrapper line copying `edits: opts?.edits`, and
`__resumeFromCheckpoint` taking `edits` as a third argument for
`agency resume`; run `pnpm run templates`. The driver's positional
`rewindFrom(checkpoint, overrides, options)` call puts `edits` in
`options`.

`driver.ts`: the two `set` refusals are deleted. `pendingOverrides`
stays in this PR (PR 2 replaces it with edits), but `respond` and
`rewindTo` no longer pass `{ overrides }`: they pass `{ edits:
fromOverrides({ locals: overrides }, checkpoint, stopOf(interrupt)) }`,
so a `set` at a stop in a batch (either breakpoint in
`fork-test.agency`) lands on that branch's frame and not on the frame
the batch's shared checkpoint names.

### Tests for the PR

`lib/runtime/state/checkpointPatch/*.test.ts`, one file per module,
using `makeCheckpoint` for frames and, for loop and branch cases,
checkpoints recorded from the debugger fixtures: add
`lib/runtime/state/checkpointPatch/fixtures.ts` that runs
`agent-shaped.agency` and `fork-test.agency` under `withLLMMocks` with a
`DebuggerTestSession`, steps to a round stop, a tool stop, inside
`search`, and inside a fork branch, and returns each stop's checkpoint
(`session.ui.state.checkpoint`). Rows:

- addresses: each rule above, including the two-label refusal and the
  loop copy path chosen over the store path.
- lower: each `op` on the fitting checkpoint; `appendMessage` at the round
  stop lands in `messages`, at the tool stop in `queuedMessages`;
  `removeTool` of an unknown name refuses; `setGuard` on the root budget
  refuses; on a time guard at a stop inside `search`, the clone's
  `timeLimit` moves by the delta; `setBranchResult` on `tool_0_…` refuses
  and on a fork branch writes `result`.
- fieldKinds: `locals.foo` data, `step` control, `signature` identity,
  `locals.__substep_2` control, `locals.runnerState.completedSteps`
  control, `locals.messagesJSON.messages` data.
- `messageLanding`: a thread ending in a tool result, in a user message,
  in an assistant text, and in an assistant tool call with one of two
  results answered.
- `guardWrites`: a cost guard with two clones (one write); a time guard
  with two clones and a limit raised by 60s (three writes, each clone up
  by 60s); `disarmed` on three copies (three writes).
- validate: one checkpoint per rule, and the rule's name in the refusal;
  and "unrelated edit accepted": `appendMessage` at the guard-trip stop
  of `guard-trip.agency` (the tripped guard is over its limit in the
  source) and `appendMessage` at the tool stop (the thread ends in
  unanswered calls in the source) both go through.
- index: a signed source (set `AGENCY_CHECKPOINT_KEY` through a host
  settings object) comes back signed and `verifyCheckpointChecksum` true;
  an unsigned one stays unsigned; the source is untouched; refusals
  return no checkpoint; `fromOverrides` of `{ locals: { mood: "happy" } }`
  equals `[{ op: "setLocal", frame: { branchPath: [] }, name: "mood", value: "happy" }]`;
  on the checkpoint from inside `search`, the same override lands on the
  tool's frame, and at the round stop on the frame that called `llm()`
  (the frame change named above).
- `resumeSetup.test.ts`: existing rows pass with the message change;
  add "edits and overrides together, the edit wins", and `restore(cp,
  { globals })` from inside a program still writes the live store
  (`tests/agency/` fixture with a `restore` and a global override).
- `rewind.ts`: `tests/agency-js/imported-module-callback-rewind/` gets a
  second case passing `edits` with `appendMessage`, and the program's
  returned messages contain the text.
- Rows that change from refused to applied, since the two `set`
  refusals go: `lib/debugger/agentShaped.test.ts` (the three rows that
  assert "not supported yet": `set` at a round stop, at a tool stop, and
  inside `search` now change the local the program then returns) and
  `lib/cli/debugSession/commands.test.ts` (the `set` refusal row); the
  `/^set (inside|before) .* not supported yet/` pattern leaves
  `FAILURE_LINES`. New row in `commands.test.ts` on `fork-test.agency`:
  `set` at the second branch's breakpoint changes that branch's local,
  not the fork's caller.

### Docs in the PR

New `docs/dev/runtime/checkpoint-patch.md`: the edit list and what each
changes, the addresses, the field-kind table, the validator's rules, the
signing rule, how the overrides translate, and the two subtleties (the
loop's thread copy; the guard copies). Answer in it: how an edit relates
to interrupts (none; a debug stop is an interrupt and the edit rides its
resume), whether handlers are affected (no; `restoreForResume` reinstalls
them), and what a serving host must do (verify, patch, resume).
`rewind.md` "Overriding values" and `resume-command.md` "Overrides" point
to it; `debugger.md` drops the two `set` limitations. `CLAUDE.md` index
and the `agency-runtime-docs` skill gain the doc.

## PR 2. Edits on the rows, with the first row (ADI-12b)

After this PR: the threads pane has a composer; Enter on a local edits
it; the footer names the row's keys; a pending edit is drawn on its row
and applied on continue; `agency debug session edit append-message` and
`edit set-local` work; a second visit can continue an edit a first visit
queued.

### Files

New, in `lib/debugger/edits/`:

- `rows.ts`: `type PaneRow` (a union by `kind`: `thread`, `guard`,
  `local`, `global`, `tool`, `branch`, `frame`, each with its address
  and the fields the pane prints) and `rowsFor(pane: PaneName, view:
  StopView): PaneRow[]`, pure, over `Checkpoint`'s readers. `StopView`
  is `{ checkpoint, stop, branchPath, pendingEdits }`. This is the only
  place a pane row is made: the five list panes' `build…Content()`
  functions in `ui.ts` draw from `rowsFor` from this PR on, so the rows
  the person sees and the rows the edits anchor to are one list.
- `keys.ts`: the binding tables, on the eval form's pattern
  (`KeyBinding<Action>` lists with `when` guards, `lib/eval/newTest/`):
  `LIST_PANE_KEYS` (`↑`/`↓` move the cursor; a row's edit keys come
  from `actionsFor(row)`), `COMPOSER_KEYS` (Enter sends, Escape keeps
  the draft, Tab leaves), and `footerHints(bindings, row)` that prints
  `key: hint` from the same tables, so the footer and the handling
  cannot disagree.
- `actions.ts`: `EDIT_ACTIONS: EditAction[]` as in the spec, and
  `actionsFor(row: PaneRow, view: StopView): EditAction[]`. This PR's
  rows: `append-message` (anchor threads/thread, key `enter` on the
  composer), `set-local` (locals/local, key `enter`).
- `pending.ts`: `previewOf(checkpoint, edits, settings): { checkpoint, applied } | { refused }`
  (a call into `patchCheckpoint`) and `describeEdits(applied): string[]`
  for the activity log.

Changed: `types.ts` (`DebuggerCommand` gains `{ type: "edit"; edits:
CheckpointEdit[] }` and `{ type: "dropEdits" }`; `DebuggerIO.setOverrides`
becomes `setPending(preview: PendingPreview)` where `PendingPreview = {
edits, applied, checkpoint: Checkpoint | null }`), `driver.ts`,
`uiState.ts`, `ui.ts`, `attach/protocol.ts` (schemas for the two
commands; `setPending` in `NOTICE_METHODS` and `SETTING_METHODS`;
`REPLY_SCHEMAS` unchanged), `attach/channelIO.ts` and `serveIO.ts`
(the renamed notice), `lib/cli/debugSession/commands.ts`, `register.ts`,
`where.ts` (pending edits in the summary), `util.ts` (`set x = 1`
parses to an `edit` command with one `setLocal`).

### The driver

`pendingOverrides: Record<string, unknown>` becomes `pendingEdits:
CheckpointEdit[]`; `takeOverrides` becomes `takeEdits`. On `edit`: run
`previewOf(stopCheckpoint, [...pendingEdits, ...command.edits], settings)`
where `stopCheckpoint` is the stop interrupt's checkpoint; on refusal log
each reason and keep the old list; on success replace the list, log the
applied lines, send `setPending({ edits, applied })`. The notice carries
no checkpoint: a 193-message thread would make every notice large, the
session replays it to each joining party, and `serveIO.ts` hands notice
arguments over as plain JSON, not a revived `Checkpoint`. Each UI
already holds the stop's checkpoint and `previewOf` is pure, so each
computes its own preview. On `dropEdits`: clear, send `setPending`
with an empty list.

The debugger never sends an edit with an omitted address. A batch of
stops shares one checkpoint whose `branchPath` and `loopStop` are the
batch's, so an omitted address would resolve to the wrong frame at a
fork's breakpoint. The UI fills each edit's address from the row it is
on, and the driver fills `fromOverrides` with `stopOf(interrupt)` for
the `set` it keeps; omitted addresses stay for TypeScript hosts and
`agency resume`, whose checkpoint is one stop's own.

`respond` passes `{ edits }` instead of `{ overrides }`. A rewind drops
the pending edits and logs "dropped N pending edits: a rewind resumes a
different checkpoint", with `preserveOverrides` (shift+up time travel)
dropping them too: the preview was computed against the stop's
checkpoint, and on the rewind target the thread may be shorter, the
loop frame may not exist, and `messageLanding` may answer differently,
so "what the person saw is what runs" would not hold. The `set`
command is kept in `DebuggerCommand` for one release and handled as
`edit` with one `setLocal` on the stop's shown frame, so an older UI
build still works against a newer run.

### The UI

`uiState.ts` holds `pending: PendingPreview` and a `cursor:
Record<PaneName, number>`; `getPanes()` draws from `pending.checkpoint
?? checkpoint`, so the preview is what the panes show, with each
pending change marked (the message's label `pending`; the local shown as
`old → new`). The stats bar shows `N edits pending` where it showed
overrides.

`handleKey` in `ui.ts` gains no cases. It picks the binding table for
the focused pane (`COMPOSER_KEYS` for `threads`, `LIST_PANE_KEYS` for
the five list panes, today's table otherwise), looks the key up, and
runs the action it names; the composer's line editor is consulted
second, as the eval form does. What the tables say:

- `LIST_PANE_KEYS`: `↑`/`↓` move `cursor[pane]` within `rowsFor(pane)`
  and scroll to keep it visible; the row under the cursor is drawn with
  the focus style. The row's edit keys are the `key` of each
  `actionsFor(row)` entry that is offered: the action runs, with
  `asks` first opening `askOneLine(ctx, label, kind)` (lifted from
  `showGuardTripForm`'s `askField` into `overlays.ts`, returning
  `string | null`), then sending `{ type: "edit", edits:
  action.toEdits(row, parsed) }`.
- `THREADS_PANE_KEYS`: the threads pane keeps its keys (`t`, `[`, `]`
  choose the thread; `c`, `s`, `n` and the rest still work with the pane
  focused). The composer is the pane's last line, `> say something to
  the model…`, drawn when the program is stopped, and Enter opens it.
- `COMPOSER_KEYS`, while the composer is open: Enter sends `{ type:
  "edit", edits: [{ op: "appendMessage", thread: { id }, text }] }` for
  the shown thread and clears the line; Escape closes the composer and
  keeps the text for the next time it opens (review focus 4). Every
  other key goes to the line editor, and the footer says `enter: send ·
  esc: keep`. Quitting with text in the composer asks first, as the eval
  form does (`y` only). Decided by the owner on 2026-10-22: Enter opens
  the composer, so the pane's keys keep working.
- Every table: `x` with edits pending sends `dropEdits`.

The footer line under the focused pane (the stats bar's right side, or a
new line in `buildStatsBar`) is `footerHints(bindings, row)`: `key: hint`
for each binding, and for an action the row does not offer, its reason.
`applies` returns `{ offered: true } | { offered: false; reason: string }`,
the same shape of answer the library gives.

### The session verbs

`register.ts`: `edit` under `session`, with one leaf per
`EDIT_ACTIONS` row generated in a loop: the anchor's choice flag
(`--thread`, `--name`) and the `asks` flag (`--text`, `--value`), plus
`--drop`. `commands.ts`: `editList(visit, record)` prints the rows that
apply at the shown stop, each verb with its choice flag's options and
default in brackets, and as JSON `{ edits: [{ name, flags: [{ flag,
choices, default }] }] }`; `edit(visit, record, name, flags, deps)` finds
the action, builds the row from the flag (default the active thread or
the shown frame), calls `toEdits`, sends `{ type: "edit", edits }` through
`sameStop`, and prints the applied lines from the `setPending` notice the
redraw carries, exit 0, or the refusal lines (`FAILURE_LINES` gains
`/^refused: /`), exit 1. `editDrop` sends `dropEdits`. `where` prints
`edits   1 pending: appended to thread main` when any.

### Tests for the PR

- `lib/debugger/edits/keys.test.ts`: `footerHints` on a local row reads
  `enter: set`, on the composer `enter: send · esc: keep · tab: leave`,
  on a root budget the reason; every binding's key appears in its hint.
- `lib/debugger/edits/rows.test.ts`: `rowsFor` for each pane on the three
  fixture stops; every row carries the address the library accepts.
- `actions.test.ts`: `actionsFor` on each row kind; `append-message`
  only on a thread row; `set-local` only on a local; `toEdits` gives the
  edit the library test used.
- `lib/debugger/edits.test.ts` (headless, `agent-shaped.agency`, mocks
  as `agentSession`): at the round-1 stop, focus threads, type `stop`
  and Enter, the threads pane shows `stop` marked pending and the stats
  bar `1 edit pending`; `c`, and at the next stop the thread's messages
  (`session.ui.state.getThreadMessages()`) end in a user message `stop`
  with no `pending` mark; Escape with text keeps the draft; `x` drops;
  Enter on `query` in locals inside `search`, type `"other"`, continue,
  the program's return reflects it (a `return` mock echoing the search
  result); the footer shows `enter: set` on a local and `enter: send`
  on the composer.
- `driver.test.ts`: `edit` with a refused edit logs the reason and keeps
  the earlier pending list; a rewind with edits pending drops them and
  logs the line; `edit` at the second breakpoint of `fork-test.agency`
  lands on that branch's frame.
- `attach/protocol.test.ts` or `server.test.ts`: the two commands parse;
  `setPending` carries `{ edits, applied }` and no checkpoint, and is
  replayed to a joining party, whose UI draws the same preview.
- `lib/cli/debugSession/commands.test.ts`: `edit` with no verb, text and
  JSON; `edit append-message --text "stop"` queues and prints the
  applied line; a refusal exits 1; `--drop`; `edit set-local --name x
  --value 5` equals the old `set`.
- `index.test.ts`: `edit append-message` in one process, `continue` in
  another, the program's output shows the message reached the model
  (review focus 5).

### Docs in the PR

`docs/dev/cli/debugger.md`: a section "Edits on the rows" (the table,
the row cursor, the composer, the preview, the keys) and the key table
rows for `↑`/`↓` in list panes, Enter, `x`. `debugger-session.md`: the
`edit` verbs and that they come from the table. `docs/site/cli/debug.md`:
the user's view of the composer and `edit`. The `.claude/commands/debug-run.md`
skill gains one line: how to say something to the model.

## PR 3. The other rows, the palette, and the saved-checkpoint paths (ADI-12c)

### Rows

`actions.ts` gains `remove-tool` (callStack/tool, `e`; `rowsFor("callStack")`
lists each loop frame's tools under it as `tool` rows from
`loopState().tools`, the `toolNames` local PR 1 added, and lists none
for an older checkpoint), `disarm-guard`
(guards/guard, `e`, no `asks`), `set-guard-limit` (guards/guard, `b`,
`asks` kind `amount`, parsed with the guard form's `parseAmount`), and
`set-branch-result` (branches/branch, `e`, `asks` kind `json`, applies
only to a running fork or parallel branch). Each is one record and its
`actions.test.ts` and `edits.test.ts` rows: disarm the `research` guard in
`guard-trip.agency` and continue past where it tripped; remove `search`
from the loop and the next round's mocked `search` call is refused; set
a fork branch's result at its breakpoint and the node's total reflects
it. The result's shape is `BranchStateJSON.result?: { result: any }`,
and `runBatch` treats a branch with `result` set as finished
(`cached` in `runBatch.ts`) when it records branch outcomes, which a
fork and a parallel block do; the test resumes the fork and reads the
total, which is the check that the shape is right.

### The palette

`lib/debugger/edits/palette.ts`: `paletteEntries(view): { sentence,
pane, rowIndex, action }[]` over every pane's rows and `actionsFor`, and
`filterPalette(entries, query)` by case-insensitive substring on the
sentence. `showPalette` in `overlays.ts`: a line editor over a list,
`↑`/`↓` to pick, Enter focuses the pane, sets the cursor, and runs the
action's key path. Key `Ctrl+K`. Test: typing `disarm` leaves one entry
and Enter disarms.

### `agency resume --edit`

`lib/cli/resumeOverrides.ts`: `ResumeOverrideFlags` gains `edit?:
string[]` and `edits?: string`; `parseResumeEdits(flags): CheckpointEdit[]`
parses each `--edit` as JSON through `checkpointEditSchema` and `--edits`
as a file holding a JSON array, with the schema's message on failure.
`AGENCY_RESUME_EDITS` is a fourth carrier beside the three in
`resume-command.md`, cleared by `withRootCarriers`; `runCliEntry` reads
it and passes `edits` as the third argument of the generated
`__resumeFromCheckpoint`, which PR 1 gave `_resumeCliFromCheckpoint`.
Test: `resume.spawn.test.ts` with `--edit` appending a
message to a fixture paused in a loop, and a malformed `--edit` refused
before the child starts.

### Serve

`createServeHandler` options gain `allowEdits?: boolean` (default
false); the HTTP adapter reads `edits` from the body only when set,
validates with `checkpointEditsSchema`, and passes it to
`respondToInterruptsForServe`; with it unset, a body carrying `edits`
is refused with 400 and "edits are not enabled on this host". Test in
`lib/serve/`: off refuses, on applies and the resumed program sees the
message, and a signed checkpoint comes back from the host re-signed.

### Docs in the PR

`debugger.md` rows for the four edits and the palette;
`docs/site/cli/resume.md` for `--edit`/`--edits`;
`how-hosted-serving-works.md` "What a checkpoint contains, and who can
change it" gains the `allowEdits` paragraph; `checkpoint-patch.md` gains
the serve and CLI entry points.

## Order and size

PR 1 is the largest and has no UI, so review it on its tests. PR 2 is
mostly `ui.ts` and the two new files; keep the row cursor and the
composer as separate commits so the review can take them apart. PR 3 is
four records, one overlay, and two entry points, and can be split if the
serve part wants its own review.
