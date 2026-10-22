# Pause and modify: editing a paused program before it resumes

Linear: ADI-12, in the project "Attach to a running Agency program",
milestone "Pause and modify a running program". Builds on the attach spec
(`2026-10-20-attach-to-a-running-program.md`) and the session spec
(`2026-10-20-agent-debug-session.md`), both shipped.

## The problem

A person can now attach to a running program, from a terminal or through
an agent, and see everything: the stack, the threads, the branches, the
guards. What they cannot do is change its mind.

The run that motivates this spec is trace `wX5GvrUq7S9ndvs5--8dX`: the
built-in agent was asked for a short profile of a person, and its research
subagent spent sixty minutes and seventy-seven model calls to produce
twenty lines. The thread shows what went wrong. Every primary source it
tried to fetch failed (403s, a 404, two domains outside its allow list, a
page that came back as markup), so the loop became search, fetch, fail,
search again, with the same two goals reworded for forty-five minutes. At
minute eleven it returned an empty answer. The reviewer sent it back with
the facts it needed, and it restarted the fetch cycle instead of writing.
It wrote the answer only when its thirty minute time guard killed it.

Fifteen minutes in, a person watching would have said one sentence: "stop
researching now, write up what you have." The debugger could show them
the loop. It could not deliver the sentence.

The goal of this spec is that, stopped anywhere in a run, a person or an
agent can make a small, named change to the paused program and continue:

```
$ agency debug session edit append-message --text "Stop research NOW. Write up what you have."
appended to thread main (193 messages); the loop sends it with its next request
stopped before round 71 (llm() in researchAgent) · research.agency:41
next    continue, where, thread, edit
```

and that the same change can be made to a checkpoint that is not running
at all: a file on disk, or a paused invocation on a server. The checkpoint
is the program, and resume is the one operation, so every edit is a change
to that document followed by a resume. A feature that worked only on a
live process would invite the question "why not any checkpoint?", and
the answer would have to be "no reason".

## What exists

Four facts shape the design. The design adds to them and replaces one.

**Reading a checkpoint already has one home.** `Checkpoint` in
`lib/runtime/state/checkpointStore.ts` is what every debugger pane and
every `agency debug session` reader goes through: `listThreads`,
`getThreadMessages`, `listBranches`, `listGuards`, `loopState`, and the
address logic under them. `stackAt` follows a branch path to a stack,
`framesAlong` walks every stack on the way, `shownFrame` picks the frame a
person is looking at, and `threadsAlong` knows that the thread a tool loop
is working on lives in `messagesJSON` on the loop's own frame, newer than
the copy in the node frame's thread store. So "the active thread at this
stop" and "frame 2 of the branch `tool_0_abc`" already resolve to JSON.

**Writing a checkpoint is scattered, and knows less than the reader.**
`applyLocalOverrides` in `lib/runtime/resumeSetup.ts` writes locals into
the last frame of the root stack. Arguments are written in
`restoreForResume`; globals are written into the live store after restore.
The three are the `ResumeOverrides` shape, `{ locals, args, globals }`,
that `respondToInterrupts`, `resumeFromCheckpoint`, `rewindFrom`, and
`agency resume` accept. None of them takes an address. That is why the
debugger's `set` refuses a stop inside a tool call, a fork, or a parallel
block, and refuses a stop before a model request or a tool call
(`lib/debugger/driver.ts`, "set inside a tool call ... is not supported
yet"): the override would land on the wrong frame, and the writer cannot
say which frame it means.

**Editing is a supported, signed operation.** When a signing key is set,
every checkpoint carries an HMAC over its whole JSON minus the signature
(`docs/dev/runtime/checkpoint-integrity.md`). The legitimate edit paths,
resume-time overrides, `CheckpointStore.pin`, and `Checkpoint.clone`,
re-sign under the host's settings. `agency resume` refuses a signed
checkpoint that does not verify, and a serving host may call
`verifyCheckpointChecksum` before `/resume`. The rule this spec keeps: an
edit is copy, change, validate, re-sign, and a checkpoint is never changed
in place.

**The tool loop already has the two stops and the one queue an edit
needs.** With a debugger attached, `runPrompt` stops before each model
request (`loopStop: "round"`) and before each tool call (`loopStop:
"tool"`). The round boundary (`lib/runtime/turnBoundary.ts`) runs before
the round stop: it appends every tool result, then delivers
`queuedMessages`, then the guard feedback, then the request step opens
and the debugger stops. So at a round stop the thread ends in a tool
result or a user message, and a user message appended there is the next
thing the model reads. At a tool stop the thread ends in an assistant
message whose tool calls have no results yet, and a user message appended
there would break the provider's turn order. `MessageThreadJSON` has
`queuedMessages`, delivered at the next round boundary after all the tool
results, which is the right place for it.

## The design in one paragraph

A new runtime module, the patch library, takes a checkpoint and a list of
edits as data and returns a new signed checkpoint or a list of refusals.
Each edit is named for what a person wants ("append a message to this
thread", "remove this tool from the loop", "disarm this guard"), carries
an address that the reader class resolves, and lowers to a change at one
path in the checkpoint's JSON. A field-kind table says which paths an edit
may touch; a validator checks the result before it is re-signed. The
existing resume overrides become sugar over the library, so every resume
path gets addressed edits without changing its callers, and the
debugger's `set` loses its two refusals. On top of the library, the
debugger gets edits on its pane rows: one table of actions, each a record
with the pane and row kind it anchors to, its key, a sentence for the
palette, the one value it may need to ask for, and the function from the
row and that value to edits. The terminal UI reads the table to put the
key on the row, draw the footer hint, and run the edit; `agency debug
session` exposes each row as an `edit` verb with flags from the same
table; neither knows an action by name. Edits made at a stop are queued
like `set` today, drawn on their rows as a preview, and applied by the
next resume. `agency resume`, the TypeScript exports, and the serve
resume route take the same edit list, serve behind a host switch.

## The user's view

### In the terminal debugger

There is no edit menu. Every editable thing is already on a row of a
pane, and the edit lives on that row, the way a web page puts the button
on the thing it acts on. The person moves to the row and presses the key
the footer names for it.

```
 threads: main ───────────────────────  guards ───────────────────────────
  …                                     research  time  29m50s / 30m  ◀
  tool  web_search_tavily → 5 results   root      cost   $0.42 / $0.50
  ─────────────────────────────────── 
  > say something to the model_         e: disarm · b: change budget
```

- **The threads pane** shows a thread's messages, and at a stop a
  composer line sits under them. Enter opens it, typing fills it, Enter
  again appends the message to that thread, and Escape closes it and
  keeps the draft. This is the main case, and it needs no menu, because
  a thread has one edit. The pane's keys keep working while the composer
  is closed: `t`, `[` and `]` choose the thread as they do today, and
  `c` continues.
- **The guards pane**, on a guard: `e` disarms it, `b` asks for the new
  budget in a one-line form. A root budget shows neither key, and the
  footer says why.
- **The locals pane**, on a local: Enter opens the value for editing in
  place, as a cell. This is `set`, and `:set x = 1` in command mode
  keeps working as the same edit.
- **The call stack pane**, on the `llm()` frame: the loop's tools are
  listed under it; on a tool, `e` removes it from the loop.
- **The branches pane**, on a fork or parallel branch that is still
  running: `e` asks for its result in a one-line form.

The footer under the focused pane shows the edits for the row the
cursor is on. The keys and the footer come from one binding table per
pane kind, as the eval form's do, so a person finds an edit by looking
at the thing they want to change and the hint cannot name a key the
pane does not take. To
make this work the panes that list things (locals, globals, call stack,
branches, guards) get a row cursor, moved with `↑` and `↓`, where today
those keys only scroll; the panes that show a stream (threads, activity,
stdout) keep scrolling, and the threads pane's composer takes typing
once Enter has opened it.

A one-line form is the guard-trip form's shape (`showGuardTripForm` in
`lib/debugger/overlays.ts`): a line editor with the prompt, Escape
cancels, and a refused value restarts the field with the reason in it.
No form asks for a thing the checkpoint already knows: the thread, the
guard, the local, the tool, and the branch are all the row the cursor
is on.

`Ctrl+K` opens a palette for someone who does not know which pane holds
the thing: typing filters the edits that apply at this stop by their
sentence ("disarm the guard research"), and Enter goes to the row and
runs the edit's key. It is the one place the edits appear as a list, and
it is filtered, never read out whole.

On submit the edit is checked against the stop's checkpoint at once, and
a refusal names the invariant ("guard research is a root budget; the
host sets its ceiling"). A note is not a refusal ("thread main ends in
an unanswered tool call; the message is queued and delivered after its
results"). An accepted edit is queued: the status bar reads `1 edit
pending`, the activity log says what will change, and the panes draw the
checkpoint as it will be after the edit, with the pending change drawn on
its row (the new message under the thread marked `pending`, the removed
tool struck through, the disarmed guard dimmed, the new value beside the
old). The program stays stopped, so the person can look. `c` continues
with the edits applied; `x` drops them. This is how `set` works today
(queued, applied by the next resume).

A stop inside a tool call, a fork, or a parallel block takes every edit
whose row is on that stack. The two refusals `set` makes today go away,
because an edit carries its frame.

### From `agency debug session`

An agent has no panes, so for it every row of the action table is an
`edit` verb, with the row's fields as flags, and the same table that
anchors an edit to a pane row names the verb:

```
$ agency debug session edit
At this stop:
  append-message   --thread [main]  --text <text>
  remove-tool      --tool <search|fetch|writeUp>
  disarm-guard     --guard <research>
  set-guard-limit  --guard <research>  --limit <30m|$0.50>
  set-local        --name <query|sources|draft>  --value <json>
  set-branch-result --branch <1|2>  --value <json>
```

`edit` with no verb prints the verbs that apply at this stop, with each
field's choices from the checkpoint and the default in brackets. A verb with its flags queues the
edit and prints the preview line and the stop, exit 0; a refusal prints
the reason, exit 1. `edit --drop` clears the pending edits. `continue`,
`step`, and the rest apply them as they would a `set`. `--json` gives the
verbs as data (the rows, their fields, the choices) and the result as
data, so an agent can build the call it needs. The verb names and flag names
come from the table: adding a row adds a verb.

### From a saved checkpoint

The same edits apply to a checkpoint nobody is running:

```
$ agency resume paused.json agent.agency \
    --edit '{"op":"appendMessage","thread":{"label":"main"},"text":"Stop research NOW. Write up what you have."}'
```

`--edit` takes one JSON edit and repeats; `--edits <file>` takes a list.
The existing `--local-var`, `--arg`, and `--global-var` flags keep working
and become edits (`setLocal`, `setArg`, `setGlobal`) on the checkpoint's
own frame. From TypeScript, every compiled module exports
`patchCheckpoint(checkpoint, edits)` beside `rewindFrom`, and
`rewindFrom`, `resumeFromCheckpoint`, and `respondToInterrupts` take
`edits` in their options bag beside the overrides they take today. A
refused edit is a thrown `CheckpointEditError` carrying the refusals, and
nothing is resumed.

On a serving host the resume route takes an `edits` list in the body
beside `interrupts` and `responses`, but only when the host turned it on
(`allowEdits` on the serve handler's options, off by default). The
hosting doc already says that an end user who receives interrupts can
change a value before approving, and that the loop should stay between
the server and a client the developer trusts; edits do not change that
argument, they make the change explicit and validated instead of a raw
rewrite of the body. A host that verifies signatures verifies the
incoming checkpoint first, applies the edits, and resumes the re-signed
result, so an edited checkpoint is never one the host did not make.

## The patch library

`lib/runtime/state/checkpointPatch/`, pure, no UI, no process. It
imports the reader's resolvers and `signCheckpoint`, nothing else from
the runtime.

```ts
export function patchCheckpoint(
  source: Checkpoint,
  edits: CheckpointEdit[],
  settings: HostSettings,
): { checkpoint: Checkpoint; applied: AppliedEdit[] } | { refused: Refusal[] };
```

The result is a new `Checkpoint`, cloned from `source`, every edit
applied in order, validated, and re-signed when the source was signed.
`applied` says what each edit did in the words the UI prints ("appended
to thread main (193 messages)", "queued on thread main, delivered after
the 2 pending tool results"). `refused` is non-empty when any edit was
refused; then nothing is returned, so a caller never resumes a partly
edited checkpoint.

### The edits

The first five, each one field in the checkpoint, each tested on its own.
`setArg` and `setGlobal` are the two the resume overrides need beyond the
five.

| Edit | Address | What changes |
|------|---------|--------------|
| `appendMessage` | thread, text, role (`user` by default) | The thread's `messages` gains one message at the end, or its `queuedMessages` when the thread ends in an unanswered tool call. |
| `removeTool` | loop frame, tool name | The loop frame's `locals.removedTools` gains the name; the loop drops the tool from its next round, as it does when the model's call was rejected too often, and a call the model already made this round still runs. The loop records the tools it was offered in a new frame local, `toolNames`, so an unknown name is refused; a checkpoint from before that field accepts any name. |
| `setGuard` | guard, `limit` and/or `disarmed` | The guard's `costLimit` or `timeLimit`, or its `disarmed` flag, in every copy of the guard the checkpoint holds (see "Where the guard edit lands"). A root budget refuses both: the host reinstalls its ceiling on every resume (`reinstallRootBudget`), so an edit would be accepted and then undone. |
| `setLocal` | frame, name, value | `locals[name]` on that frame. |
| `setBranchResult` | fork or parallel branch, value | The branch's `result` becomes `{ result: value }`; the block that owns it reads the value when it resumes, as it would a returned one (`runBatch` skips a branch with a result). A tool-call branch is refused: the loop records a tool's outcome in its step bookkeeping, not in the branch's `result`, so "answer this tool call" is a control edit, listed under not goals. |
| `setArg` | frame, name, value | `args[name]` on that frame. |
| `setGlobal` | module, name, value | The module's global in the store the stopped code reads: `globals.store[module][name]` at the root, and the branch's own copy (`globalsJSON.store`) at a stop inside a fork or parallel branch. |

The edit list is a discriminated union on `op`, validated with zod at the
boundary (the CLI flag, the HTTP body, the `edits` option), so a caller
that sends the wrong shape is told so before any checkpoint is read.

### Addresses

An address names a part of the checkpoint the way the panes show it, so a
person or an agent can say it without reading frames. Every address
resolves through the reader class, which gains a locator beside each
reader (the thread view with the path of the list a resume reads, the
guard with the paths of every copy, the branch and the frame with
theirs), so the checkpoint's layout stays in the one file that knows it
and the patch library never spells a path.

| Part | Address | Resolves through |
|------|---------|------------------|
| Frame | `{ branchPath?: string[], depth?: number }` or `{ branchPath?, scope: string }` | `stackAt(branchPath)`; `depth` counts from the top of that stack, 0 being its last frame; `scope` is the nearest frame of that scope name. Omitted, the stop's own shown frame (`shownFrame`), which at a loop stop is the caller under the loop's frame. |
| Loop frame | `{ branchPath? }` | The last `runPrompt` frame on that stack. |
| Thread | `{ id }` or `{ label }` | `threadsAlong(branchPath)`; omitted, the active thread. A label that names two threads is refused with both ids. |
| Message | `{ thread, index }` | A position in that thread's messages, as the threads pane numbers them. Not used by the first five edits; reserved for the next ones. |
| Branch | `{ path: string[] }` or `{ key }` | `listBranches`; a bare key is looked up from the root and refused when it is not unique. |
| Guard | `{ label }` or `{ index }` | `listGuards(branchPath)`; a label on two guards is refused with their indices. |
| Module | `{ module }` | `globals`; omitted, the checkpoint's `moduleId`. |

The logs viewer's row ids are the model here: a short stable name that
the UI prints and accepts back, so what a person sees in a pane is what
they type into a verb.

### Where the thread edit lands

Mid tool loop there are two copies of the thread the model is reading:
the node frame's thread store, and `messagesJSON` on the `runPrompt`
frame, refreshed at every step. On resume, `runPrompt` rebuilds the thread
from `messagesJSON` and adopts it into the store's thread
(`restoreThreadForResume` in `lib/runtime/threadRepair.ts`), so
`messagesJSON` is the copy that counts and the store's copy is overwritten
from it. `appendMessage` on a thread that a loop frame holds a copy of
writes the loop's copy; the address layer hides this, since
`threadsAlong` already pairs the two. A thread with no loop copy (the
program is stopped outside any `llm()`) gets the message in the store.

Which list the message goes in depends on the stop. A thread whose last
message is an assistant message with tool calls that have no results yet
cannot take a user message after it; the edit puts it in `queuedMessages`
instead, and the round boundary delivers it after the results, before the
next request. The applied line says so. A thread that ends in anything
else gets the message appended directly, and the next request sends it.
The validator decides which by reading the thread, not by reading the
stop kind, so the rule holds for a checkpoint with no stop at all.

### Where the guard edit lands

A guard can be in the checkpoint more than once. The stack that pushed
it holds the guard in its `guards`. A branch stack below it, a tool
call, a fork arm, or a parallel item, holds an inherited copy: a cost
guard is re-cloned from the parent on resume and not serialized with the
branch, but a time guard's clone is serialized in the branch's
`inheritedTimeGuards`, with the parent's remaining time as its
`timeLimit` and its own `disarmed` flag, and resume adopts that clone by
`guardId` instead of re-cloning (`rehydrateInheritedGuardsFrom` in
`lib/runtime/state/stateStack.ts`). The guards pane shows the clone's
figures for a stop inside the branch, since those are the ones the
stopped code is metered by.

So a guard address resolves to every copy that shares the `guardId`
along the branch path, and `setGuard` writes all of them. `disarmed` is
written as given to each. A new cost limit is written to the owning copy
only, since the clones are rebuilt from it. A new time limit is written
to the owning copy, and each clone's `timeLimit` moves by the same
difference, so its remaining time changes by what the budget changed by.
The applied line names the guard once.

### Field kinds and the validator

Every path in a checkpoint is one of three kinds. The table lives in the
patch module and is the only place the kinds are stated.

- **Data**: locals, args, globals, messages and queued messages, a loop's
  `removedTools`, guard limits and `disarmed`, a branch's `result`. The
  edits above change these.
- **Control**: `step` and every local whose name starts with `__`, the
  tool loop's bookkeeping (in a `runPrompt` frame every local other
  than the thread copy's two message lists and `removedTools`:
  `runnerState`, `toolCallRound`, `pendingToolCalls`, `rejectedCalls`,
  and the rest), `nodesTraversed`, `deserializeStackLength`, `mode`,
  the branch keys themselves, a guard's `spent` and `elapsedMs`. A path
  alone cannot tell a loop's `toolCallRound` from a user's local of the
  same name, so the kind is decided by the frame's scope name and the
  path together. Changing one moves the program counter or rewrites
  what the loop believes it has done. No edit in this spec touches
  them, and the validator refuses an edit whose path lands on one. When
  a jump is wanted later it is its own edit, presented as a jump, not a
  value.
- **Identity**: `id`, `moduleId`, `nodeId`, `moduleFingerprints`,
  `signature`, `traceId`, a thread's `id`, a guard's `guardId`. Never
  edited.

After the edits are applied the validator checks the result against the
source and names each invariant that held in the source and is broken
in the result. The source decides what counts: the checkpoints the
debugger stops on already break two of the rules below (a guard-trip
stop has a guard over its limit, and a tool stop has a thread ending in
unanswered tool calls), and an edit that touches neither must go
through. The rules:

- no thread ends in an assistant message with tool calls and no results,
  unless the loop has a branch running for each of them;
- every branch key an edit named exists;
- a guard whose `spent` exceeds its limit is `disarmed`, or the edit that
  lowered the limit is refused as "would trip at once";
- a `result` on a `tool_*` branch is refused as a control edit. A branch
  stopped on an interrupt takes a result: the debugger's own stop is one,
  and a resume skips a branch that has a result, so the answer goes
  unread;
- a guard edit on a root budget is refused, naming the host ceiling;
- the result parses under `checkpointSchema` (`lib/runtime/state/schemas.ts`),
  so a shape the runtime would refuse on load is refused here with the
  schema's message.

The `__proto__` check `checkedOverrides` makes today moves here, as the
first rule of the validator: no name an edit writes may be a prototype
key.

### Signing

`patchCheckpoint` re-signs when `source.signature` is set, under the
settings it is given, as `applyLocalOverrides` does today. It never
verifies: verification is the caller's job before the edit, as it is
before a resume (`agency resume` and a host's `verifyCheckpointChecksum`).
The debugger edits a checkpoint it made itself; `agency resume` verifies
first; a serving host verifies first. A checkpoint a key was never set
for stays unsigned through an edit.

### The resume overrides become edits

`ResumeOverrides` stays as an accepted input. `applyLocalOverrides`
keeps its signature and becomes a translation: each `[name, value]` is a
`setLocal` on the frame at `source.branchPath`, which is the frame the
checkpoint was taken in, and the list goes through `patchCheckpoint`. The
args write in `restoreForResume` becomes `setArg` the same way. Globals
are written into `checkpoint.globals` as `setGlobal` edits and restored
with the rest, instead of into the live store afterwards. The one path
that stays is `_pendingArgOverrides`, the args for a function frame that
has not been entered yet: that is a runtime mechanism, not a checkpoint
field, and it is left as it is.

Every resume entry point gains `edits?: CheckpointEdit[]` beside
`overrides`. When both are given, the overrides are translated first and
the edits follow, so an explicit edit wins. The `rewind.applyOverrides`
export is kept and `patchCheckpoint` is exported beside it from
`portable.ts` and from every compiled module.

## The debugger's side

### The action table

`lib/debugger/edits/actions.ts` holds one table, `EDIT_ACTIONS`, and the
UI never names a row. A row:

```ts
type EditAction = {
  /** The verb: `append-message`, and the row's id in `--json`. */
  name: string;
  /** The pane and the kind of row the edit sits on. */
  anchor: { pane: PaneName; row: RowKind };
  /** The key on that row, `e`, `b`, or `enter`; the footer prints it. */
  key: string;
  /** The footer word and the palette sentence, of the row: "disarm",
   *  "disarm the guard research (time, 29m50s of 30m)". */
  hint: (row: PaneRow, view: StopView) => string;
  sentence: (row: PaneRow, view: StopView) => string;
  /** Whether the edit is offered on this row, or the reason it is not,
   *  which the footer prints: a root budget takes no guard edit; a
   *  finished branch takes no result. */
  applies: (row: PaneRow, view: StopView) => { offered: true } | { offered: false; reason: string };
  /** The one value the person types, or none: the message text, the new
   *  budget, the local's value, the branch's result. */
  asks?: { label: string; kind: "text" | "json" | "amount" };
  /** The edits the row and the typed value mean. */
  toEdits: (row: PaneRow, value: unknown, view: StopView) => CheckpointEdit[];
};
```

`PaneRow` is what a pane row already is to the UI: a thread, a guard, a
local, a tool under the loop's frame, a branch, each with the address
the patch library takes. `StopView` is the checkpoint, the stop, and the
branch path the panes are on, built once per render by `uiState.ts`,
which already holds all three. The rule the owner set: no edit asks for a
thing the checkpoint knows, so a row has at most one typed value, and
everything else comes from the row the cursor is on. For the CLI the
anchor becomes the verb's choice flag (`--guard`, `--tool`, `--name`,
`--branch`, `--thread`) and `asks` becomes its typed flag.

The six first rows: `append-message` (threads, the composer),
`remove-tool` (call stack, a tool under `llm()`), `disarm-guard` and
`set-guard-limit` (guards), `set-local` (locals, Enter), and
`set-branch-result` (branches). `set-local` is the existing `set`, moved
into the table; command mode's `set x = 1` parses to the same edit. A
seventh row is one record in this file and one test, and the UI shows
it on its row with no other change.

### Pending edits and the preview

The driver keeps `pendingEdits: CheckpointEdit[]` where it keeps
`pendingOverrides` today, and `takeOverrides` becomes `takeEdits`. On a
new edit it runs `patchCheckpoint` on the stop's checkpoint at once, for
the refusal or the applied line, and tells the UI the pending list and
the applied lines through a `setPending` notice (`setOverrides` today).
The notice carries no checkpoint: each UI already holds the stop's
checkpoint and the patch is pure, so each UI computes the preview it
draws, and a joining party gets the same notice and draws the same
preview. The real application happens on resume: `respond` passes
`edits` where it passes `overrides`. The preview and the resume apply
the same list to the same checkpoint through the same function, so
what the person saw is what runs. A rewind resumes a different
checkpoint, on which the preview may not hold, so a rewind drops the
pending edits and says so in the activity log.

Every edit the debugger sends carries its address. When several
branches stop at once they share one checkpoint whose location is the
batch's, so an omitted address would resolve to the wrong frame; the UI
fills the address from the row, and the driver fills the `set` it keeps
from the stop record. Omitted addresses are for a TypeScript host or
`agency resume`, whose checkpoint is one stop's own.

### Over the channel

A terminal or a CLI visit sends an edit as a command, one more member of
`DebuggerCommand` and of the reply schemas in
`lib/debugger/attach/protocol.ts`: `{ type: "edit", edits: CheckpointEdit[] }`
and `{ type: "dropEdits" }`. The driver answers with the preview or the
refusal as it answers `set` with a redraw today. The rows and the verbs
need nothing new on the wire: the CLI builds them from the table and the
checkpoint it was shown, as the terminal does. Two parties see the same
pending edits, since the driver holds them and the preview is replayed to
a joiner with the other settings (`sessionRules.ts`, `settings`).

## Not goals

**A raw path edit in the public interface.** `setAt(path, value)` is the
one primitive inside the library and the field-kind table gates it. It is
not offered as an edit, a verb, or a body field in this spec. It can be
exposed later in a small change. Once exposed it could not be withdrawn
without breaking callers.

**Moving the program counter.** A jump to another statement, or marking a
loop step done, is a control edit and gets its own spec with its own
presentation. Answering a tool call by hand belongs there too: the loop
records a call's outcome in `runnerState` and its reply message in the
thread, so giving a `tool_*` branch a value is a control write plus a
thread write, not a data edit.

**Deleting or rewriting messages.** Removing a message from a thread
changes what the model already saw and can orphan a tool result; it is a
later edit with the message address reserved for it above.

**Editing without a stop.** An edit applies to a checkpoint, and a live
program yields one at a stop. There is no "poke a running program".

**Serve by default.** The resume route accepts edits only behind
`allowEdits`.

**A stdlib edit function.** As with attach, editing a run is the owner's
power, not a program's.

## Testing

The patch library is tested on checkpoints the existing fixtures produce,
with no process and no UI: each edit on its own against a checkpoint from
a node, from inside a tool call, and at each loop stop; the thread edit
landing in `messages` at a round stop and in `queuedMessages` at a tool
stop, then resumed through `rewindFrom` on the fixture so the program
prints the message the model was sent; the resume overrides producing the
same checkpoint as the equivalent edits; every validator rule with one
checkpoint that breaks it; a signed checkpoint re-signed and verifying,
an unsigned one staying unsigned; the refusals naming the invariant.

The action table is tested as data: every row's `applies`, `hint`, and
`sentence` on the pane rows of the three stop views, and `toEdits`
producing the edit the library test used. The terminal is driven
headlessly in the style of `docs/dev/cli/debugger-tests.md`: focus the
threads pane, type into the composer, see the pending message under the
thread, continue, and read the program's output; move the cursor to a
guard and disarm it; Enter on a local and type a value; the palette
filtering to one edit and running it; a refused value restarting its
field; the footer naming the row's keys and saying why a root budget has
none. The session verbs get rows in `commands.test.ts` (the verb list as
text and JSON, a queued edit, a refusal, `--drop`) and one end-to-end row
in `index.test.ts` that appends a message and continues. `agency resume --edit` gets a spawn test beside
the overrides one. The serve route gets a test with `allowEdits` off
(refused) and on (applied and re-signed).

## Files

New: `lib/runtime/state/checkpointPatch/` (the edits, the addresses,
the field kinds, the validator, `patchCheckpoint`); `lib/debugger/edits/`
with `actions.ts` (the table), `rows.ts` (the pane rows with their
addresses, which the panes draw and the actions anchor to), and
`palette.ts` (the filter); `docs/dev/runtime/checkpoint-patch.md` for
the library and a section in `docs/dev/cli/debugger.md` for the row
edits,
with the `CLAUDE.md` index and the `agency-runtime-docs` and
`agency-cli-docs` skills updated together. Changed:
`lib/runtime/resumeSetup.ts` and `rewind.ts` (overrides as edits,
`edits` in the options), `interrupts.ts` and `portable.ts` and the
`imports.mustache` template (the exports), `lib/runtime/state/checkpointStore.ts`
(the resolvers made public), `lib/debugger/types.ts`, `driver.ts`,
`ui.ts`, `uiState.ts`, `overlays.ts`, `attach/protocol.ts` (the command,
the preview, the row cursor, the composer, the palette),
`lib/cli/debugSession/` (`edit`), `lib/cli/resumeOverrides.ts`
(`--edit`), `lib/serve/createServeHandler.ts` (`allowEdits`),
`docs/site/cli/debug.md` and `docs/site/cli/resume.md`.

## The PRs

1. **The patch library.** `checkpointPatch/` with the seven edits, the
   addresses, the field kinds, the validator, and the tests; the resume
   overrides re-based on it; `edits` accepted by every resume entry point
   and by `rewindFrom`; `patchCheckpoint` exported. No UI. After this PR
   a TypeScript host can make every edit in this spec on a checkpoint it
   holds.
2. **Edits on the rows, with one row.** The action table, the row cursor
   in the list panes, the composer under the thread, the footer hints,
   the preview, the `edit` verbs in `agency debug session`, and
   `append-message` as the one row, plus `set-local` as the moved `set`.
   After this PR the Grant Sanderson run can be told to stop researching
   at minute fifteen, from a terminal or from an agent. The palette can
   wait for PR 3, when there are enough rows to filter.
3. **The other rows and the saved-checkpoint paths.** `remove-tool`,
   `disarm-guard`, `set-guard-limit`, `set-branch-result`, the palette;
   `agency resume --edit`; the serve route behind `allowEdits`.
