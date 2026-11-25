# Saved sessions: save and resume for `agency agent`

An interactive `agency agent` session is one run: `agent.agency` sets the
session up and runs the REPL, and the REPL calls a turn. After each line
the run is saved as a checkpoint, and a later run restores it with
`--continue` or `--resume`. Perry saves its sessions in the same file
layout, in a folder of its own (`perry-sessions/`), with a run file in
another format. Neither can resume a session the other saved.

An `--incognito` session has no record, so nothing is saved, and `/rename`
says the session is not saved. The launcher turns logging off for
`--incognito`. The agent checks this itself before it starts:
`incognitoProblem` refuses the run when `_isLogging()` (from
`lib/stdlib/statelog.ts`) says the statelog still records. That happens
when the agent is started without the launcher, for example
`agency run lib/agents/agency-agent/agent.agency --incognito`, which keeps
the logging the agent was built with.

A one-shot run (`-p`) saves nothing either: it has no record.

## Files

`<agent home>/sessions/<cwd slug>/` holds two files per session:

- `<id>.json`, one checkpoint of the run.
- `<id>.meta.json`, the record: `id, cwd, brain, created, lastActive,
  turns, title`, and `runFormat: "checkpoint"`.

There is no shared index, so two agents in one directory cannot race on
it; the picker's list is derived from the record files. Writes go through
a temp file and a rename. The agent home is `~/.agency-agent` or
`AGENCY_AGENT_HOME`. The slug is the working directory with every
non-alphanumeric character replaced by `-`, so sessions are per project
directory, as in Claude Code.

**Sessions an earlier agent saved** can't be continued. Their record has
no `runFormat` (an agent older than the field) or `runFormat: "savedRun"`
(the agent that ran its sessions on a session program). The picker and
`--continue` leave them out (`listSessions` in `sessions.agency`), and
`--resume <id>` on one prints `This session was saved by an earlier
version of agency agent and can't be continued.` Session search still
reads them.

A session this agent saved can stop being resumable too. A checkpoint
records a hash of the generated code of each module it is paused in
(`docs/dev/runtime/checkpoint-code-fingerprints.md`), and a saved session
is paused in `agent.agency`, `lib/repl.agency` and `std::ui/cli`. A
release that changes one of those ends the sessions saved before it.
`resumeSession` checks this before it prints anything
(`_checkpointFitsThisCode`) and gives the same line.

The file I/O is TypeScript (`lib/stdlib/agentSessions.ts` and
`lib/stdlib/agentReplSession.ts`), like the REPL history file: harness
bookkeeping under the agent's own directory, never a tool, so it raises no
interrupt and the user's policy is not asked about it.

## Modules

- `lib/agents/agency-agent/lib/sessions.agency` — the listing, and the
  picker label.
- `lib/agents/agency-agent/lib/sessionTitle.agency` — the one-line title:
  from the tail of the conversation (the reply included) on turn 1 and
  every `TITLE_EVERY` turns after. One LLM call in its own thread; fails
  open to "".
- `lib/agents/agency-agent/lib/resume.agency` — which session this run is
  (`chooseSession`), the picker, a new session's record, and the restore
  of a saved one (`resumeSession`).
- `lib/agents/agency-agent/lib/sessionPolicy.agency` — the session's
  policy, and its own policy file.
- `lib/agents/agency-agent/lib/record.agency` — the session's record: the
  per-turn record (`recordTurn`), `/rename` and `/fork`.
- `lib/stdlib/agentReplSession.ts` — the REPL's submit, which saves.

## When a session is saved

The REPL's `onSubmit` is `_sessionOnSubmit` in `agentReplSession.ts`. It
calls the agent's `dispatch` for the line, and then saves in one of two
ways.

**After a line that ran to its end.** It calls `recordTurn`, and when
that returns a target it takes a checkpoint of the run and writes it.
The line's Agency frames have returned by then, so the checkpoint is
"the REPL waiting at its prompt". `recordTurn` returns a target after a
turn, and after `/rename` and `/fork`. A `/model` or `/preset` change is
saved with the next turn.

**When a line stops on an approval no rule decides.** While a line runs,
the policy handler leaves such an approval unanswered
(`deferUndecided`, `docs/dev/agents/approval-policies.md`). The line then
comes back to `_sessionOnSubmit` as its interrupts, and the first carries
a checkpoint of the run at the approval. That checkpoint is written, with
the record as it was before the turn (`waitingTarget`). Then:

1. `_sessionOnSubmit` returns `false`, so `repl()` ends through its own
   cleanup.
2. `startInteractive` in `repl.agency` sees there is a checkpoint to
   restore (`_takeCheckpointToRestore`) and restores it. The run is back
   at the approval, inside the `repl()` call, which starts again.
3. The REPL submits once without reading a line (`_setReplResubmit` in
   `cli.ts`). That call picks up the frames of the line that stopped. The
   line in the call is not read: the saved frames have their own.
4. This time the handler asks the person, because `_sessionOnSubmit`
   turned the deferring off for a submit that picks a line up. The turn
   goes on from the answer.

So the code before the approval runs once, and the same restore serves a
resume in a new process. Three things follow from it:

- **A line that still stops after the person was asked** is given to the
  REPL as its interrupts, which prints that the turn stopped. Restoring
  again would ask the same thing forever.
- **Only a submitted line defers.** At startup, and for the session's own
  setup under the handler, the handler asks at once, since no checkpoint
  taken there could be picked up by a submit.
- **Everything `agentReplSession.ts` and the resubmit keep is outside the
  run's state** (`processSlot`), so the restore leaves it alone. A value
  an Agency statement made would come back from the checkpoint as it was
  saved.
- **These restores are not counted against `maxRestores`.** The cap
  (100 a run) stops a restore loop, and the REPL is one run for the whole
  sitting. `_takeCheckpointToRestore` marks the restore that follows as
  uncounted (`_nextRestoreUncounted` on the run's context), since a
  person's answer paces each one.
- **An approval a subprocess raises is asked in place**, and has no saved
  checkpoint (`approval-policies.md`, "A program that saves a checkpoint
  when it has to ask").
- **The pick-up depends on `onSubmit` being the first Agency function the
  REPL calls after it starts.** The saved frames are handed to the next
  frames pushed. A change to `repl()` that calls `status`, or any Agency
  callback, before the first submit would hand it the line's frame.

**A cancelled line** (Esc) saves nothing. The call comes back as an
`AbortedResult`, which `_sessionOnSubmit` throws on as the error the REPL
prints as "cancelled". The conversation keeps what the turn did before
Esc. A session whose process stops while a turn runs, with no approval
on screen, resumes from the end of the last line that finished.

## How a resume works

`chooseSession` picks the record. `resumeSession` reads the checkpoint,
prints the saved conversation (`_readTranscript`), and calls `restore`.
The run's state becomes the saved one, and the program goes on from the
saved point: inside `repl()`, which starts fresh. `_pickUpOnResume` has
set the REPL to submit once without reading a line, with the person asked:

- A session saved at an approval is picked up there, and the approval is
  drawn before anything is typed.
- A session saved at its prompt gets an empty line, which does nothing.

The setup in `main` runs before the restore, as for a new session: the
models, memory and MCP are the process's own, and a restore replaces only
the Agency state. `installSessionHooks` runs before it too, so the
functions `_sessionOnSubmit` calls are the ones this process loaded.

Everything the run holds comes back from the checkpoint: the
conversation, every subagent's thread, the models, the LLM options, the
`let` globals. So `--model` and similar flags given on a resume are
ignored.

**Policy flags are not ignored.** The policy handler keeps its policy in
the run's state, so a restore brings back the policy of the sitting that
saved the session. `interactive` in `agent.agency` works out the policy
for this sitting first (`resumedSessionPolicy`: the session's own policy
file with the flags given now on top, or the saved policy for a session
with no file of its own) and hands it over with `policyAfterRestore`. The
handler takes it at its first interrupt after the restore.

## The session's own policy

A new session started with `--policy`, `--approve` or `--reject` saves
what they resolve to as its own policy file,
`<agent home>/session-policies/<id>.json` (`newSessionPolicy`), and its
"always" answers go there. Every other session runs under `policy.json`.

- The file is kept outside the session's checkpoint
  (`lib/stdlib/agentSessionPolicy.ts`). In the checkpoint, an edit to the
  saved file would change what the session is allowed to do. The built-in
  policies guard it as they guard `policy.json`: none but `approve-all`
  approves a write, edit, remove, copy or move of a file under
  `session-policies/`.
- On a resume, `sessionRunPolicy` picks the policy. A session with a file
  of its own gets that policy and nothing from `policy.json`: a reject
  that follows an approve means "reject, unless the approve already
  answered", so no rule is lifted out of one policy into another. The
  flags given at the resume go ahead of the session's rules for the same
  effect.
- A policy file that can't be read, or is not a valid policy, refuses the
  resume. It never falls back to `policy.json`, which could approve what
  the session's own policy would ask about.
- A session that ends before its first turn is never saved, and its
  policy file is removed (`forgetUnsavedPolicy`).
- `/fork` copies the file to the new id and points the handler at the
  copy (`forkSessionPolicy`).
- The handler is installed with `answersOnly: true`: the policy in memory
  can hold the flags given now, and only what a person answers "always"
  belongs in the file.
- Which file the session saves to is the handler's to say
  (`policyFileInUse` in `std::policy`). `usesSavedPolicy`, which `/policy`
  asks, and `forkSessionPolicy` read it there. A copy kept in the agent's
  own state would be the saving sitting's after a resume with other
  flags.

### The transcript

What a reopened session shows is its transcript: a list of what the
person typed and the agent's final replies, in order. It is the same two
things the live view draws for a turn. The conversation thread is not
shown, because it also holds text the person never typed: notes and `!`
output, the cancel note, the project block, an expanded slash command,
subagent prompts, the runtime's own messages, and the compaction summary.

`messageTurn` in `repl.agency` adds to the list. It adds what the person
typed before the turn runs, and the reply after the turn when there is
one. A turn whose `runTurn` returns a failure prints the failure and adds
no reply.

The list is kept in the run's globals, in a module of its own named
`__agentTranscript` (`lib/stdlib/agentTranscript.ts`, the only file that
spells the name), the way the fetch cache keeps its state. So every
checkpoint saves it and every restore brings it back:

- A turn cancelled with Esc keeps its user entry and has no reply, as
  the conversation keeps what the turn did.
- A turn whose process stopped is not in the saved checkpoint, so its
  entry is not either.
- A turn saved at an approval has its user entry in the approval's
  checkpoint, and picking it up does not add it again.
- `/fork` keeps the list, since the fork goes on from the same run.

The entries are added at the top level of the run, outside any branch, so
the list is in the root globals. A `fork` or `parallel` branch runs on its
own copy of the globals: a call moved into a branch would write to that
copy instead.

`_readTranscript` in `agentSessions.ts` returns the list when the
checkpoint has one. A session saved before the list existed has none, and
`_readTranscript` reads the thread instead, so the session can still be
shown and searched. Such a session cannot go on (see "Files"). A run with
no list is therefore always a new one, and its list starts empty.

Compaction does not touch the list, so a compacted session reopens with
its whole conversation.

The list has no size limit, on purpose. It grows with every turn, and
every checkpoint carries all of it: at about 3 KB a turn, a 500-turn
session carries about 1.5 MB. That is fine because a session runs only in
the terminal and under Perry, which save checkpoints to local files. A
hosted resume has a size limit, which is why the fetch cache and the
spill store cap themselves (`lib/runtime/fetchCache.ts`, `spill.md`). If
a session run is ever resumed through a hosted server, this list needs a
cap too.

The conversation the model reads is the run's active thread: a brain
opens no `thread` block of its own, so every turn's `llm()` calls land on
it. Before and after each turn, `runTurn` in `lib/turn.agency` records
that thread's id with `setConversationThread` (`lib/record.agency`).
`recordTurn` copies the id into the
session record as `conversationThread`. The title refresh, compaction,
and the context percentage read the thread. `showTranscript` in
`transcript.agency` draws the transcript with the renderers the live
turns use.

The zod schemas in `lib/runtime/state/schemas.ts` must name every field the
thread store serializes; a field missing there is dropped when the
checkpoint is read back (see `docs/dev/runtime/checkpointing.md`).

### `/rename`

`/rename <title>` calls `renameSession` in `record.agency`, which sets the
record's title and pins it so the periodic title refresh leaves it alone.
The REPL prints the line (`renameLine`), and the save after the line
writes the record.

## `/fork`

`/fork` calls `forkSession` in `record.agency`, which gives the
session a new record: a new id, the same turn count and title, and
`forkedFrom` set to the original's id. The session is saved under the new
id from then on, and its own policy file is copied to it
(`forkSessionPolicy`). The original session's two files are not touched.
They hold the conversation as it was last saved, and `--resume <id>`
reopens it.

The footer and the resume picker show a fork's title with `(fork)` after
it (`displayTitle` in `sessions.agency`). The mark comes from
`forkedFrom` and is not part of the stored title, so the title refresh
every fifth turn does not lose it.

To try something from an earlier point, resume that session and run
`/fork` before the next message. A turn taken before `/fork` is saved to
the original first.

## Searching saved sessions

`searchSessions` in `lib/sessionSearch.agency` is a tool the coordinator
carries. It finds messages in the sessions saved for this project
directory, so the model can answer "what did we decide last week?".

- **What is read.** `_searchSessions` in `agentSessions.ts` reads the 50
  most recently used sessions, newest first, in either format. For each
  it reads the transcript with `_readTranscript`, so it searches what the
  person typed and the final replies. A session saved before the
  transcript existed is read from the thread its record's
  `conversationThread` names. The running session is left out.
- **What matches.** A message that holds every word of the query, in any
  order and letter case. No index is kept and no model is called.
- **What comes back.** Up to 3 hits a session and 25 in all. A hit is the
  session's id and title, the date it was last used and how long ago that
  was (`2026-11-05`, `3d ago`), the role, and 200 characters on each side
  of the first matched word. The time is given as a date because a model
  reads a millisecond count unreliably.
- **Approval.** The tool raises `std::read` with the real sessions
  directory and `*.json` as the file name, so the policy decides. With no
  sessions directory yet it returns nothing and raises nothing. A user
  who answers "always" saves a `std::read` rule for that directory. The
  rule is not specific to this tool: it also lets the model's ordinary
  `read` tool open the session files there, which hold every tool result,
  every subagent thread, and the program state.
- **Records with no thread id.** A record saved before the id was
  recorded has no `conversationThread`, so its session gives no hits.
- **Compacted sessions.** Messages a compaction removed are not in the
  checkpoint. What can be found of them is the text of the summary that
  replaced them.
- An `--incognito` session has no record, and the tool returns nothing
  there.

## Not yet

`--fork <id>`, `/resume` inside a session, saving one-shot (`-p`) runs,
and cleanup of old sessions.
