# Saved sessions: save and resume for `agency agent`

An interactive `agency agent` session is a run of the session program
(`program.agency`, `docs/dev/agents/session-core.md`), driven through the
session driver (`docs/dev/agents/session-driver.md`). The driver saves it
at every pause once it has a turn, and a later run picks it up with
`--continue` or `--resume`. Perry saves its sessions the same way, in the
same folders, so either front-end can go on with a session the other
saved.

An `--incognito` session has no record, so nothing is saved, and `/rename`
says the session is not saved. The launcher turns logging off for
`--incognito`. The agent checks this itself before it starts:
`incognitoProblem` refuses the run when `_isLogging()` (from
`lib/stdlib/statelog.ts`) says the statelog still records. That happens
when the agent is started without the launcher, for example
`agency run lib/agents/agency-agent/agent.agency --incognito`, which keeps
the logging the agent was built with.

A one-shot run (`-p`) saves nothing either: its start has no record.

## Files

`<agent home>/sessions/<cwd slug>/` holds two files per session:

- `<id>.json`, the saved run: the pause the session waits at, each
  interrupt with its checkpoint, and the turn in progress when it was
  saved in the middle of one (`SavedRun` in `lib/stdlib/agentSessions.ts`).
- `<id>.meta.json`, the record: `id, cwd, brain, created, lastActive,
  turns, title`, `runFormat: "savedRun"`, and `heldBy`, the front-end that
  has the session open.

There is no shared index, so two agents in one directory cannot race on
it; the picker's list is derived from the record files. Writes go through
a temp file and a rename. The agent home is `~/.agency-agent` or
`AGENCY_AGENT_HOME`. The slug is the working directory with every
non-alphanumeric character replaced by `-`, so sessions are per project
directory, as in Claude Code.

**Sessions saved by the old terminal loop** have `runFormat: "checkpoint"`
(or none): one checkpoint, which only that loop could resume. The picker
and `--continue` leave them out, and `--resume <id>` on one prints
`Session <id> was saved by an older version of the agent and can't be
resumed.` Session search still reads them.

The file I/O is TypeScript (`lib/stdlib/agentSessions.ts` and
`lib/stdlib/agentDriver/savedRun.ts`), like the REPL history file: harness
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
  (`chooseSession`), the picker, and a new session's record.
- `lib/agents/agency-agent/lib/terminal.agency` — starting and resuming
  the session run, and the session's policy.
- `lib/agents/agency-agent/lib/record.agency` — the session's record, in
  the session run: the per-turn record (`recordTurn`), `/rename` and
  `/fork`.
- `lib/stdlib/agentTerminalSession.ts` — when the terminal saves, and the
  holder check.

## When a session is saved

At every pause once the session has a turn: after a turn, after a command
that changes it (`/rename`, `/model`, ...), and while a turn waits on an
approval. A session saved at an approval is loaded back waiting on it, and
the approval is asked again. A session whose process stopped while a turn
ran goes back to the turn's start, as if the person had cancelled it, and
the next message says so.

## How a resume works

`chooseSession` picks the record. The shell prints the saved conversation
(`_savedTranscript`: the session's transcript, read from the saved run's
checkpoint) and calls `_resumeSession`, which takes hold of the
session, loads the saved run, and goes on from where it was.

Everything the session run holds comes back from the checkpoint: the
conversation, every subagent's thread, the models, the LLM options, the
`let` globals. So `--model` and similar flags given on a resume are
ignored. Policy flags are not: a session that carries its own policy runs
under it, with the flags given now laid on top (`session-driver.md`,
"Which policy a session runs under").

### The transcript

What a reopened session shows is its transcript: a list of what the
person typed and the agent's final replies, in order. It is the same two
things the live view draws for a turn. The conversation thread is not
shown, because it also holds text the person never typed: notes and `!`
output, the cancel note, the project block, an expanded slash command,
subagent prompts, the runtime's own messages, and the compaction summary.

The session core adds to the list in its `message` arm. It adds the
`text` of the answer before the turn runs, and the reply after the turn
when there is one. A turn whose `runTurn` returns a failure reports a
`session.error` and adds no reply.

The list is kept in the run's globals, in a module of its own named
`__agentTranscript` (`lib/stdlib/agentTranscript.ts`, the only file that
spells the name), the way the fetch cache keeps its state. So every
checkpoint saves it and every restore brings it back:

- A cancel goes back to the pause from before the turn, so the turn's
  entry goes away with its messages. So does a turn the driver rolls back
  because a leg failed or the process stopped.
- A turn paused on an approval has its user entry in the approval's
  checkpoint, and a resume does not add it again.
- `/fork` keeps the list, since the fork goes on from the same run.

The core adds entries at the top level of the run, outside any branch, so
the list is in the root globals. A `fork` or `parallel` branch runs on its
own copy of the globals: a call moved into a branch would write to that
copy instead.

`_readTranscript` in `agentSessions.ts` returns the list when the
checkpoint has one. A session saved before the list existed has none, and
`_readTranscript` reads the thread instead, so the session can still be
shown and searched. Such a session cannot go on: its saved
core code differs from the running one, so `canResume` refuses it
(`docs/dev/runtime/checkpoint-code-fingerprints.md`). A run with no list
is therefore always a new one, and its list starts empty.

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
that thread's id with `setConversationThread` (`lib/record.agency`), and
the pause reports it as `thread`. `recordTurn` copies the id into the
session record as `conversationThread`. The title refresh, compaction,
and the context percentage read the thread. `showTranscript` in
`transcript.agency` draws the transcript with the renderers the live
turns use.

The zod schemas in `lib/runtime/state/schemas.ts` must name every field the
thread store serializes; a field missing there is dropped when the
checkpoint is read back (see `docs/dev/runtime/checkpointing.md`).

### `/rename`

`/rename <title>` sends a `rename` answer. The session run sets the
record's title, pins it so the periodic title refresh leaves it alone, and
says so in a notice. The pause after it reports the record, and the driver
saves it.

## `/fork`

`/fork` sends a `fork` answer. `forkSession` in `record.agency` gives the
session a new record: a new id, the same turn count and title, and
`forkedFrom` set to the original's id. The driver saves under the new id
from then on, and copies the session's own policy file to it
(`copyCarriedPolicy`). The original session's two files are not touched.
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
