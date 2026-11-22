# Review: Session Transcript Implementation Plan

Plan: `2026-11-21-session-transcript.md`, in this folder.

## Summary

The design is sound. It is Alternative B from the architecture review, and
it settles that review's open question about how the reader gets the list:
the list lives in a globals module of its own, `__agentTranscript`, the way
the fetch cache does. I checked the plan's claims against the code on
`main` and most of them hold. The plan's numbered behaviours (cancel,
resume after an approval, `/fork`) follow from where the list is kept, as
the plan says.

Four things should change before anyone builds it. The first is a test
that cannot pin what it says it pins. The second is that the worktree is
one commit behind `main`, and that commit touches three of the files this
plan edits. The third is a missing test for the upgrade path. The fourth
is a type mismatch in how `_addToTranscript` feeds the live thread to the
reader's loop.

Line numbers below are from `main` unless I say otherwise.

## Fix before building

### 1. The approval test uses a session that never pauses for approval

Task 3 says: "The existing `editor` session, whose turn pauses on an edit
approval." It does not pause. `editor` starts with
`{ ...PIN, "std::edit": [{ action: "approve" }] }`
(`tests/agency-js/session-core/test.js:367-370`), so the policy approves
the edit and the turn runs to the end. The test's own comment says so: "no
one is asked".

The session that pauses is `asker` (`test.js:388-396`). It starts with the
default policy, pauses on the edit, and is approved with
`asker.answer(undefined)`.

As written, `result.transcriptAtApproval` would read the checkpoint of the
next `agent::sessionInput` pause, after the turn finished. It would hold
the user entry and the reply, and the expected value "one entry" would
fail. If someone then changed the expected value to match, Review Focus 1
would have no test behind it.

Change the case to use `asker`:

```js
await asker.answer(message("edit the note"));
result.transcriptAtApproval = _readTranscript(asker.pause[0].checkpoint, "");
// ...the existing editThatIsAsked lines...
await asker.answer(undefined);
result.transcriptAfterApproval = transcriptOf(asker);
```

Expected: `[{ role: "user", content: "edit the note" }]` at the approval,
and then that entry once, followed by the reply.

### 2. Merge `main` into the branch first

The worktree is at `223e64439`. `main` has `2827d478c` (#1533, "a folder
answer moves a session to another folder") on top. That commit changes
`core.agency`, `machine.ts`, `tests/agency-js/session-core/test.js` (104
added lines), and `session-core/fixture.json`. Tasks 2 and 3 edit all four.

The `message` arm itself did not change, so the design still fits. The
plan's line numbers are from the old base, though: on `main` the arm is
`core.agency:413-460` and `submit` is `machine.ts:157-178`. Add a step
before Task 1 that merges `main` into the branch, and update the two line
references. Merging (rather than rebasing) matches the repository's rule
against force pushes.

### 3. No test runs the upgrade path end to end

Decision 3 says a session saved before this change keeps its history: the
first new entry starts the list from the thread. Review Focus 3 says Task 1
and Task 3 pin it. They pin the two halves separately:

- Task 1 tests `withEntry(null, threadMessages, entry)` with a hand-built
  array.
- Task 3's reader fallback test reads a checkpoint that has no list.

Neither test runs `_addToTranscript` inside the core, where it has to find
the live thread with `threadById(conversationThread())` before the turn
starts. If the thread store is not visible at that point, or the id does
not match, `threadById` returns null, the list starts empty, and an
upgraded session reopens with only its new turns. Both of the plan's tests
would still pass.

There is evidence it will work: the core already calls
`compactIfDue(conversationThread())` from the same scope
(`core.agency:459`), and compaction uses the same `threadById`. That call
runs after a turn. This one runs before, so a test is still needed.

Add a case to `session-core/test.js`. After `chat`'s first turn, copy its
checkpoint, delete the list from the copy, and send a second message from
the copy:

```js
const oldSave = JSON.parse(JSON.stringify(chat.pause));
delete oldSave[0].checkpoint.globals.store.__agentTranscript;
const upgraded = { ...chat, pause: oldSave };
// resume `upgraded` with message("after the upgrade") the way
// session.answer does, then:
result.upgradedTranscript = transcriptOf(upgraded);
```

Expected: the first turn's user entry and reply, then
`"after the upgrade"` and its reply. Before writing the case, check that
the test's run does not set a checkpoint checksum. If it does, the edited
checkpoint is refused (`docs/dev/runtime/checkpoint-integrity.md`), and
the test should build its old save another way.

### 4. Live messages and saved messages have different shapes

`transcriptOfMessages` is the loop from today's `_readTranscript`. It reads
saved JSON: `m.role` and `_contentToString(m.content as
MessageJSON["content"])` (`lib/stdlib/agentSessions.ts:266-275`).

`_addToTranscript` gives it the live thread instead. `threadById` returns
a `MessageThread`, and its `getMessages()` returns `smoltalk.Message`
class instances (`lib/stdlib/agentCompaction.ts:201`). The compaction code
reads those through its own helpers (`contentText`, `messageText`), not
through `_contentToString`.

The loop may happen to work on the instances. The plan should not depend
on that. Convert them first, so both callers hand the loop the same shape:

```ts
const threadMessages = thread === null ? [] : thread.getMessages().map((m) => m.toJSON());
```

The Task 1 interface for `_addToTranscript` should say this.

## Smaller points

5. **Name how `_addToTranscript` gets the run.** The plan says it "reads
   the list from the current run's globals". Say `currentRun()`, as
   `lib/stdlib/agentTerminalDriver.ts:107` does, so the implementer does
   not look for a run parameter.

6. **Say that the list is in the root globals.** A `fork` or `parallel`
   branch runs on its own copy of the globals, and a checkpoint stores
   each branch's copy separately (`lib/runtime/state/checkpointStore.ts:718-748`).
   The core adds entries at the top level, outside any branch, so the
   root's store is the right one, and `transcriptIn` should read
   `cp.globals`. One sentence in the dev doc would stop a later change
   from moving a call into a branch without noticing.

7. **There are two kinds of failed turn.** Decision 5 covers a turn whose
   `try runTurn(…)` returns a failure. That is the "fail this turn" test:
   the stub client throws (`test.js:130-131`) and the core catches it.
   A leg that fails in the driver is different. `legFinished`
   (`machine.ts`, the `back` phase) returns to the pause the turn started
   from, so the user's entry is dropped along with the thread's messages,
   and the next message carries a "failed" note. A process that stops in
   the middle of a turn does the same (`lib/stdlib/agentDriver/savedRun.ts:78`).
   This behaviour is fine. Add it to Decision 5 so nobody reads it as a
   bug later.

8. **A cancelled request is not shown after a reopen.** Today a reopened
   session shows the cancel note as a `>` line, which at least names the
   cancelled request. After this change it shows neither the request nor
   the note. The live view did show the request when the user typed it.
   I think this is the right result, since the agent does not remember
   the request either. Add a sentence to Decisions so it is a choice on
   record.

9. **Task 2's file list misses `docs/dev/agents/session-driver.md`.** It
   names `withCancelNote` at lines 59 and 438. Task 3 Step 5's search
   would find both, but listing the file in Task 2 puts the doc change in
   the same commit as the rename.

10. **The notes test needs no new stub code.** The stub already records
    every request's last user text in `userTextsSent` (`test.js:95`), so
    `result.notedModelSawNotes = userTextsSent.includes("NOTE-A\n\nNOTE-B\n\nhi")`
    is enough. The exact string is right: grounding goes in as a system
    message (`lib/agents/agency-agent/lib/grounding.agency:64-66`), so
    nothing else is joined onto the user's text.

## Claims I checked and found correct

- **Slash commands.** Expansion happens in `runTurn`, after the core
  (`lib/agents/agency-agent/lib/turn.agency:111`). So `text` in the
  `message` arm is the `/cmd` the user typed, and the list records that.
- **The model gets the same text.** `withCancelNote` returns
  `` `${note}\n\n${message}` `` (`lib/stdlib/agentDriver/run.ts:191`).
  `withPendingNotes` joins notes and message with `"\n\n"`
  (`lib/agents/agency-agent/lib/pendingNotes.agency`). With the cancel
  note as the last note, the joined text is the same as today.
- **Cancel removes the entry.** `cancelTurn` sends the run back to
  `phase.pause`, the pause the turn started from (`machine.ts`,
  `cancelTurn`). That checkpoint was taken at the `agent::sessionInput`
  raise, before the new call adds the user entry.
- **The fetch cache precedent.** `lib/runtime/fetchCache.ts:34-42` and
  `:130-135` keep state in a `__`-named globals module with
  `run.globals.get` and `run.globals.set`, and its comment explains why
  that module stays out of `__internal`. The same reasons apply here.
- **Checkpoint patches treat the list as control data.** Any path segment
  starting with `__` is classed as control
  (`lib/runtime/state/checkpointPatch/fieldKinds.ts:29`). That is the
  safer class for this list.
- **No mid-turn user messages.** Nothing in `lib/agents` or the driver
  calls `queueMessage`, so the architecture review's worry about queued
  user messages inside a handoff does not apply to this design.
- **The refused-target test can fail.** The new `_readTranscript` returns
  the list before it looks at the thread id, so an entry added before the
  start-target check would show up even though the pause's thread is `""`.
- **`withCancelNote` has no other callers.** Outside tests and docs, only
  `machine.ts:162` calls it.

## What I did not verify

- I read the code and ran nothing.
- I did not check whether `smoltalk.Message` exposes `content` in the JSON
  shape (point 4). The fix works either way.
- I did not check whether the session-core test sets a checkpoint
  checksum (point 3).
- I did not read Perry.
