# Checkpoint patch: editing a paused program before it resumes

A checkpoint is the whole paused program as JSON, and resume is the one
operation on it. So a change to a paused program is a change to that
document followed by a resume. This doc is the library that makes the
change: what an edit is, how it names the part of the checkpoint it
changes, which fields it may touch, how the result is checked and signed,
and how the old resume overrides fit in. The design is
`docs/superpowers/specs/2026-10-21-pause-and-modify.md`.

The library is `lib/runtime/state/checkpointPatch/`, one concept per file:

- `edits.ts`: the `CheckpointEdit` union and the address types, as zod
  schemas, so a caller at a boundary (a CLI flag, an HTTP body) is told
  about a wrong shape before any checkpoint is read.
- `addresses.ts`: one resolver per address kind, each returning what it
  found and where in the JSON.
- `fieldKinds.ts`: the table that says whether a path is data, control,
  or identity.
- `lower.ts`: what each edit writes, as a list of writes at paths.
- `validate.ts`: the invariants a patched checkpoint must keep, as a
  table of rules.
- `index.ts`: `patchCheckpoint`, which runs the four in order, and
  `fromOverrides`, which turns the old override shapes into edits.

## The one call

```ts
patchCheckpoint(source, edits, settings, at?): { checkpoint, applied } | { refused }
```

`source` is a `Checkpoint` or its plain JSON. The result is a new
checkpoint with every edit applied in order, or every reason an edit was
refused and no checkpoint, so a caller never resumes a partly edited
one. `applied` is one line per write in the words the debugger prints
("appended to thread main (193 messages)"). The source is never changed:
the writes go into a deep copy, and a signed source comes back signed
under `settings` with a fresh signature.

`at` is the stop the edits are made at: a branch path and, when the stop
is one of the tool loop's own, which kind. It matters because several
branches can stop at once and share one checkpoint whose own location is
the batch's, so only the stop record says which frame a person meant. A
caller with no stop record leaves it out and the checkpoint's own
location is used.

## The edits

| Edit              | Address                     | What it writes                                                                                                                |
| ----------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `appendMessage`   | thread, text, role          | A message at the end of the thread, or on its queue when the thread ends in tool calls with no results yet.                   |
| `removeTool`      | loop, tool name             | The name onto the loop frame's `removedTools`; the loop drops the tool from its next round. An unknown name is refused.      |
| `setGuard`        | guard, limit and/or disarmed | The guard's limit or `disarmed`, on every copy of it the checkpoint holds. A root budget is refused.                         |
| `setLocal`        | frame, name, value          | `locals[name]` on that frame.                                                                                                 |
| `setArg`          | frame, name, value          | `args[name]` on that frame.                                                                                                   |
| `setGlobal`       | module, name, value         | The module's global in the store the stop reads: the root's, or a fork or parallel branch's own copy.                         |
| `setBranchResult` | branch, value               | The branch's `result`, so the block that owns it reads the value as a returned one. A tool call's branch is refused.          |

An omitted address means the stop's own: the frame the stop shows (at
one of the loop's own stops, the caller under the loop's frame), the
active thread, the nearest tool loop above the stop.

## Addresses

An address names a part of the checkpoint the way the debugger's panes
show it. Every address resolves through the reader class, `Checkpoint`
in `checkpointStore.ts`, and the resolvers never spell a path: each
reader hands back the path of what it found (`jsonPath` on a thread
view, a branch, the loop state, the globals; `jsonPaths` on a guard, one
per copy). The walk under all of them is `walkFrames(branchPath)`, every
frame along a branch path with its path, so the layout of the JSON is
known in one file.

| Part   | Address                                            | Rule                                                                                                                  |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Frame  | `{ branchPath?, depth? }` or `{ branchPath?, scope }` | `depth` counts from the end of the stack, 0 the last frame; `scope` is the nearest frame of that name from the end.   |
| Loop   | `{ branchPath? }`                                  | The nearest `runPrompt` frame along the whole branch path; a stop inside a tool call has its loop on the parent stack. |
| Thread | `{ id }`, `{ label }`, or `{ active: true }`       | A label on two threads is refused with both ids.                                                                      |
| Branch | `{ path }` or `{ key }`                            | A bare key on two branches is refused with both paths.                                                                |
| Guard  | `{ label }` or `{ index }`                         | The index is the guards pane's; a label on two guards is refused with both indices.                                   |
| Module | a module id                                        | The checkpoint's own when omitted.                                                                                    |

## Two things that are easy to get wrong

**Which copy of the thread.** Mid tool loop there are two copies of the
thread the model is reading: the node frame's thread store, and
`messagesJSON` on the `runPrompt` frame, refreshed at every step. On
resume the loop rebuilds its thread from `messagesJSON` and adopts it
into the store's thread (`restoreThreadForResume` in `threadRepair.ts`),
so the loop's copy is the one that counts. The thread reader pairs the
two and reports the loop copy's path when there is one; a loop inside a
tool call runs on a store that is not serialized, so its copy is the
only record and is listed on its own. An edit never has to know this.

**Which list a message goes in.** A thread whose last assistant message
made tool calls that the messages after it do not all answer cannot
take a user message yet: providers refuse a request where a call has no
result. `messageLanding(thread)` in `checkpointStore.ts` says
`"queued"` then, and the message goes on the thread's `queuedMessages`,
which the round boundary (`turnBoundary.ts`) delivers after every result
and before the next request. Otherwise it says `"messages"` and the
message is appended. The function reads the thread, not the stop kind,
so the rule holds for a checkpoint with no stop at all.

**Which copy of the guard.** A guard can be in the checkpoint more than
once. The stack that pushed it holds it in `guards`; a branch stack
below holds a clone in `inheritedTimeGuards` when the guard is a time
guard, with the parent's remaining time as its limit, and resume adopts
that clone by `guardId` instead of re-cloning
(`rehydrateInheritedGuardsFrom` in `stateStack.ts`). A cost guard's
clones are rebuilt from the owner on resume and are not serialized. So
`guardWrites` (`lower.ts`) writes `disarmed` to every copy, a cost limit
to the owner only, and a time limit to the owner and each clone's limit
by the same difference. A root budget is refused for both, since
`reinstallRootBudget` puts the host's ceiling back on every resume and
the edit would be undone.

## Field kinds

Every path is one of three kinds, decided by `fieldKind(path, scopeName)`
in `fieldKinds.ts`. The frame's scope name is part of the question
because the tool loop keeps its bookkeeping in locals under names a
user's function may use for values: `toolCallRound` is control in a
`runPrompt` frame and data in `main`.

- **Data**, which an edit may change: locals, args, globals, a thread's
  messages and queue, the loop's `removedTools`, a guard's limit and
  `disarmed`, a branch's `result`.
- **Control**, which moves the program counter or rewrites what the loop
  believes it has done: `step`, every name starting with `__`, the loop
  frame's other locals (`runnerState`, `toolCallRound`, `pendingToolCalls`
  and the rest), `nodesTraversed`, `deserializeStackLength`, `mode`, a
  guard's `spent` and `elapsedMs`. No edit writes one; the write is
  refused by name.
- **Identity**, never edited: ids, `moduleFingerprints`, `signature`,
  `traceId`, a guard's `guardId`.

## The validator

`VALIDATION_RULES` in `validate.ts` is one record per invariant, and
`validate(source, result)` runs each on both and keeps a refusal only
when the rule held in the source and fails in the result. The source
decides what counts because the checkpoints the debugger stops on
already break two of the rules: a guard-trip stop has a guard over its
limit, and a tool stop has a thread ending in unanswered calls. An edit
that touches neither must go through, and one that breaks either is
refused by the rule's name. The rules:

- a thread ending in an assistant tool call with no result and no
  running `tool_` branch for it;
- a guard whose spend is over its limit and is not disarmed ("would trip
  at once");
- the result parses under `checkpointSchema` (`schemas.ts`).

There is no rule about `step`: no edit can write it.

## Signing

`patchCheckpoint` re-signs when the source carried a signature, under
the settings it is given. It never verifies: verification is the
caller's job before the edit, as before any resume (`agency resume` and
a serving host's `verifyCheckpointChecksum`, see
`checkpoint-integrity.md`). The debugger edits a checkpoint it made
itself; `agency resume` verifies first; a serving host verifies first.

## The resume overrides are edits

Every resume path, `restoreForResume` in `resumeSetup.ts` and so
`respondToInterrupts`, `rewindFrom`, `resumeFromCheckpoint`, and `agency
resume`, takes `edits` beside the old `overrides` and applies both in
one patch through `applyResumeEdits`: the overrides first, translated by
`fromOverrides` into `setLocal`, `setArg`, and `setGlobal` edits on the
frame at the stop, then the edits, so an explicit edit wins. The old
shapes keep working for every caller.

One thing changed with that: an override used to land on the last frame
of the root stack whatever the checkpoint's branch path. It now lands on
the frame the checkpoint was taken in, which inside a tool call is the
tool's frame and at one of the loop's own stops is the frame that called
`llm()`. That is the frame a person means, and it is why the debugger's
`set` no longer refuses a stop on a branch stack or at a loop stop. The
debugger passes the stop record's location as `at`, since a batch of
stops shares one checkpoint.

Globals are written into the checkpoint's store by the patch and
restored with the rest. The one write that stays outside the patch is
`_pendingArgOverrides`, the args for a function frame the program has
not entered yet; that is a runtime mechanism, applied at the frame's
entry, and `applyRestoreOverrides` keeps it. An in-program
`restore(cp, { globals })` also goes through `applyRestoreOverrides`,
on every run loop, and keeps writing the live store as before.

## Interrupts, handlers, and hosts

An edit has nothing to do with interrupts: a debug stop is an interrupt
and the edit rides its resume, as `set` always did, and a program's own
interrupts are answered as they were. Handlers are never serialized, and
every path here resumes through `restoreForResume`, which reinstalls
them; no new resume loop was added. A serving host that lets a client
send edits must verify the incoming checkpoint's signature, apply the
edits, and resume the re-signed result, so an edited checkpoint is never
one the host did not make.

## The loop records its tools

No checkpoint used to say which tools a loop was offered: the list is an
argument to `runPrompt`, not a frame local. `initLoopFrame`
(`loopFrame.ts`) now records their names in the frame as `toolNames`,
which `loopState().tools` reads, so `removeTool` can refuse a name the
loop does not have. A checkpoint from before the field has `tools:
null`, and any name is accepted.

## Tests

`checkpointPatch/*.test.ts`, one file per module, on a hand-built
agent-shaped checkpoint (`testCheckpoints.ts`: a node frame with the
store's thread, a loop with its newer copy and an unanswered call, that
call's branch with its own loop, a fork below it, a labelled time guard
with a clone, and a root budget). `checkpointStore.test.ts` covers the
locators. `resumeSetup.test.ts` covers the overrides as edits and the
frame change. `agentShaped.test.ts` has `set` at a loop stop, inside a
tool call, and in a fork branch. `tests/agency-js/rewind-with-edits/`
rewinds a real program with edits and with the old overrides, and reads
the message the model was sent.
