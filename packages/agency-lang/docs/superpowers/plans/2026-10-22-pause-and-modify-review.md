# Review: pause and modify plan (2026-10-22)

Reviewed against `origin/main` at `7327b019e`. The local `main` checkout
is behind it and does not have `lib/cli/debugSession/` or
`sessionRules.ts`, so every file and line below is from `origin/main`.

The plan's shape works: edits as data, one pure lowering function, one
field-kind table, one action table that both the terminal and the CLI
read. Most of the "What is already there" section checks out against the
code. The findings below are places where the plan, implemented as
written, would refuse edits it should accept, write to the wrong place,
or break an existing feature. They are in order of how much they would
cost to discover in review.

## Would ship wrong behavior

### 1. The validator refuses every edit at a guard-trip stop and at a tool stop

The plan's validator checks the whole patched checkpoint and "runs on
the result with no knowledge of which edit produced it". Two of its
rules are already broken in the checkpoints the debugger stops on:

- At a guard-trip stop, the tripped guard has `spent > costLimit` (or
  `elapsedMs > timeLimit`) and is not disarmed. That is what a trip is.
  The rule "a guard over its limit and not disarmed" fails, so an
  `appendMessage` at that stop is refused even though it touches no
  guard. This is the motivating case: the person wants to say "write up
  what you have" at the moment the guard trips.
- At a tool stop, the thread ends in an assistant message whose tool
  calls have no results. The rule "a thread ending in an unanswered tool
  call with no running `tool_` branch for it" fails for every call whose
  branch has not been created yet. Then the `appendMessage` the plan
  routes to `queuedMessages` at a tool stop is refused.

Fix: run the validator on the source and on the result, and report only
the invariants that hold in the source and fail in the result. This also
matches the spec's wording ("the edit that lowered the limit is refused
as would trip at once"). Add both stops to the validator's tests as
"unrelated edit accepted".

### 2. A batch of stops shares one checkpoint, so an omitted address resolves to the wrong frame

When several branches stop at once, `runBatch` stamps one shared
checkpoint at the batch's location and writes it onto every interrupt in
the batch (`docs/dev/runtime/concurrent-interrupts.md:105`). The
`branchPath` and `loopStop` on that checkpoint belong to the batch, not
to the stop the person is looking at. The stop's own location is only in
the stop record (`stopOf(interrupt)` in `lib/debugger/driver.ts:1028`).

The plan says an omitted address means "the checkpoint's `branchPath`
and `shownFrame`", and `fromOverrides` uses
`{ branchPath: checkpoint.branchPath }`. At either breakpoint in
`fork-test.agency`, a `set` or a `setLocal` with no frame would land on
the frame that runs the fork, not inside the branch.

Fix: the debugger never sends an edit with an omitted address. The UI
and the driver fill `branchPath` (and `loopStop`, for `shownFrame`) from
the stop record, including for the old `set` command the driver keeps
for one release. Keep omitted addresses for TypeScript hosts and
`agency resume`, where the checkpoint is a single stop's. Add a
`fork-test.agency` row to `commands.test.ts`: `set` at the second
branch's breakpoint changes that branch's local.

### 3. Pending edits are previewed on one checkpoint and applied to another on a rewind

The plan has `rewindTo` pass the pending edits to `rewindFrom`. The
driver previews edits against the stop's checkpoint, but a rewind
resumes a different checkpoint, chosen from the rolling window. On that
checkpoint the thread may be shorter, the loop frame may not exist yet,
and the rule that decides between `messages` and `queuedMessages` may
come out the other way. With `preserveOverrides` (`driver.ts:945`, the
shift+up time travel), the edits survive across several rewinds.

The spec's promise "what the person saw is what runs" does not hold on
this path. Two options:

- Drop pending edits on a rewind, and log that they were dropped. This
  is simplest.
- Re-run `previewOf` against the rewind target, and refuse the rewind
  when any edit is refused there.

Either way, name the choice in the plan and test it.

### 4. `setGlobal` has the wrong path, misses branch globals, and the plan breaks `restore(cp, { globals })`

Three separate problems:

- The JSON path is `globals.store[module][name]`, not
  `globals[module][name]` (`GlobalStoreJSON` in
  `lib/runtime/state/globalStore.ts:7`). `resolveModule` has to look in
  `globals.store` too.
- Inside a fork or parallel branch, the code reads the branch's own copy
  of the globals, `branches[key].globalsJSON` (`globalsAt` in
  `checkpointStore.ts`). A `setGlobal` at a stop inside a branch would
  write the root's globals, which the branch does not read. Either
  address the branch's copy when the frame address has a `branchPath`,
  or refuse `setGlobal` inside a branch.
- The plan says `applyRestoreOverrides` keeps only its
  `_pendingArgOverrides` branch. `applyRestoreSignal` calls it for an
  in-program `restore(cp, { globals })` (`lib/runtime/checkpoint.ts:88`,
  called from `node.ts:546`, `interrupts.ts:788`, `rewind.ts:170`).
  Removing the globals branch breaks that call without an error. Keep
  the globals branch for `applyRestoreSignal`, or change that path to
  patch too, and add a test of `restore` with globals to the PR.

### 5. The checkpoint does not record which tools a loop has

`removeTool` refuses "no tool <name> in this loop" by reading "the tools
the last assistant message could call, else `loopState`". An assistant
message records the calls the model made, not the tools it was offered.
`loopState` returns the round and `removedTools` only. The tool list is
`args.clientConfig.tools` (`lib/runtime/prompt.ts:552`), which is not a
frame local and is not in the checkpoint.

So the refusal has no data source, and neither do PR 3's `tool` rows
under the `llm()` frame. Options:

- Add a frame local at `runPrompt` init, for example
  `self.toolNames = rawTools.map(name)`, in PR 1. Checkpoints taken
  before the field have no tool rows and accept any name.
- Accept any name and say "removed from the next round" without
  checking it.

Also, at a tool stop the current round's calls are already chosen.
`removedTools` is applied at the round boundary (`prompt.ts:1843`), so a
call to the removed tool in this round still runs. The applied line
should say "from the next round".

### 6. Compiled modules will not pass `edits` through without wrapper changes

Each export in `imports.mustache` (lines 58 to 77) copies its options
by name: `overrides: opts?.overrides, metadata: opts?.metadata, ...`.
Adding `edits?` to the functions in `interrupts.ts` and `rewind.ts` does
not reach a compiled module's callers until each wrapper line and each
options type (`__ResumeOptions`, `__RewindOptions`,
`__ResumeFromCheckpointOptions`, `ServeResumeOptions`) also changes.
PR 1 only lists adding `patchCheckpoint` to the template.

Two corrections to "What is already there":

- `resumeFromCheckpoint` does not take `overrides` today
  (`imports.mustache:60`).
- `agency resume` resumes through `__resumeFromCheckpoint` →
  `_resumeCliFromCheckpoint` (`imports.mustache:63`), which PR 3's
  `--edit` work needs to change. The plan does not mention it.

The driver calls the module's `rewindFrom` with positional arguments,
`(checkpoint, overrides, options)` (`driver.ts`, `rewindTo`), so the
edits go in `options`.

## Needs a design change before coding

### 7. The readers return objects, and the resolvers need JSON paths

The plan says each resolver returns `{ path, found }` built on the
existing readers, with `threadsAlong` and `branchActiveStack` made
public. The readers do not keep paths. `framesAlong` flattens every
stack into one list, and `threadsAlong` works from that list, so a view
cannot say which frame it came from.

The plan's thread path rule also has a gap. A loop inside a tool call
runs on a store that is not serialized. `threadsAlong` lists that loop's
copy as its own view, with no `newer` field and no entry in the store.
The rule "loop path when the view has `newer`, else the store path"
would write to `threads.threads[id]`, which does not exist.

Fix: add one walker that yields `{ frame, path }` for every frame along
a branch path, rebuild `stackAt`, `framesAlong`, and `threadsAlong` on
it, and have `ThreadView` carry the path of the messages it shows. Then
the pane and the edit agree on which list a message goes into. Also
decide what to do when `messagesJSON` is a bare array: `toolCallName`
accepts that form and `loopThreadCopy` ignores it.

### 8. A path alone cannot say whether a `runPrompt` local is data

`fieldKind(path)` puts `locals.*` in data, with `runnerState` and
`__substep_*` as exceptions. The `runPrompt` frame has more control
state in its locals: `toolCallRound`, `pendingToolCalls`,
`rejectedCalls`, `rejectionCounts`, `repeatStreak`, `toolErrorCounts`,
`validationAttempt`, and `__initialized` (`prompt.ts:524-534`). A user
function can also have a local named `toolCallRound`, which should be
data.

Fix: give `fieldKind` the frame's `scopeName` as well as the path. In a
`runPrompt` frame, use an allow list: `messagesJSON.messages`,
`messagesJSON.queuedMessages`, and `removedTools` are data, and every
other local is control. In every frame, a segment starting with `__` is
control, matching `docs/dev/language/reserved-names.md`.

### 9. `resolveLoopFrame` searches one stack, and the loop can be on a parent stack

At a stop inside `search` (a tool call), `stackAt(branchPath)` is the
tool's own stack, which has no `runPrompt` frame. The loop that called
the tool is on the parent stack. `loopState` already handles this. It
searches `framesAlong(branchPath)` for the last frame with
`scopeName === "runPrompt"` and `toolCallRound !== undefined`. Use the
same rule, ideally the same function, in `resolveLoopFrame`.

### 10. The source-map step rule cannot fail

No edit writes `step`, because `fieldKind` refuses it. The validator
rule "a frame's `step` past the scope's last step" therefore cannot fail,
and it brings a `sourceMap` parameter that the debugger and
`agency resume` would have to supply. Cut the rule and the parameter.
Add them in the spec that adds jump edits.

## Corrections to the plan text

### 11. Existing tests assert the refusals PR 1 removes

PR 1 deletes the two `set` refusals. These tests assert them:
`lib/debugger/agentShaped.test.ts:183`, `:353`, `:604`;
`lib/cli/debugSession/commands.test.ts:193-197`. The pattern
`/^set (inside|before) .* not supported yet/` in `FAILURE_LINES`
(`commands.ts:388`) also goes. List them in "Tests for the PR" as rows
that change from refused to applied.

### 12. Local tests are not blocked

The global constraints say "Local vitest is blocked by a repo guard; CI
runs the tests." I found no such guard: there is no hook in the
settings files, and `pnpm test:run` exists. `CLAUDE.md` says to run the
tests for the files you changed locally, save the output to a file, and
leave the full agency suite to CI. Following the plan as written means
pushing three PRs without running their own tests. Replace the line
with the `CLAUDE.md` rule.

### 13. Overrides move to a different frame, and the plan should say so

Today `applyLocalOverrides` writes the last frame of the root stack,
whatever the checkpoint's `branchPath` is (`resumeSetup.ts:59-73`).
Under `fromOverrides`, a local override on a checkpoint taken inside a
tool call lands on the tool's frame. At a loop stop it lands on the
frame that called `llm()` (`shownFrame` picks index -2). This is likely
the better behavior, and it changes what `agency resume --local-var`
does on such a checkpoint. The test "the three override shapes produce
the same checkpoint as the equivalent edits" does not cover it, because
both sides use the new rule. Add a test that pins the new frame for a
branch checkpoint, and name the change in the PR description and in
`resume-command.md`.

## Smaller points

### 14. `setPending` ships a full checkpoint on every edit

The notice carries the preview checkpoint, and `sessionRules.ts` replays
it to every joining party. A 193-message thread is a large notice, and
`serveIO.ts` casts notice arguments without reviving them, so the UI
would get plain JSON, not a `Checkpoint`. The UI already holds the stop's
checkpoint, and `previewOf` is pure. Send `{ edits, applied }` and let
each UI compute its own preview. This also avoids the `Checkpoint`
revival question.

### 15. The composer takes `c`, `t`, `[`, and `]`

With the threads pane focused, printable keys go to the composer. The
spec says `t`, `[` and `]` choose the thread "as they do today", and the
person cannot press `c` to continue without leaving the pane first. The
owner should decide between:

- the plan's rule, with Tab to leave the composer; or
- a composer that takes typing only after a key such as Enter or `i`,
  so the pane's keys keep working.

### 16. Check the `setBranchResult` shape before writing it

The plan writes `branches[key].result = { result: value }`. I did not
check `BranchStateJSON`'s `result` field or how `runBatch` reads it on
resume. Confirm the shape against `runBatch.ts` and add a test that
resumes the fork and reads the value, which PR 3 already lists.
