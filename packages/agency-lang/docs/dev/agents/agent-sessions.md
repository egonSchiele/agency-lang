# Saved sessions: save and resume for `agency agent`

An interactive `agency agent` run is saved after every completed turn, and a
later run can pick it up with `--continue` or `--resume`. The saved thing is
a runtime checkpoint, not a transcript: restoring it brings back the
conversation, every subagent's session thread, the agent's `let` globals,
and the LLM options, and execution continues from the saved point.

## Files

`<agent home>/sessions/<cwd slug>/` holds two files per session: `<id>.json`
(the value of `getCheckpoint`) and `<id>.meta.json` (the record: `id, cwd,
brain, created, lastActive, turns, title`). There is no shared index, so two
agents in one directory cannot race on it; the picker's list is derived from
the record files. Writes go through a temp file and a rename. The agent home is `~/.agency-agent` or `AGENCY_AGENT_HOME`. The slug
is the working directory with every non-alphanumeric character replaced by
`-`, so sessions are per project directory, as in Claude Code.

The file I/O is TypeScript (`lib/stdlib/agentSessions.ts`), like the REPL
history file: harness bookkeeping under the agent's own directory, never a
tool, so it raises no interrupt and the user's policy is not asked about it.

## Modules

- `lib/agents/agency-agent/lib/sessions.agency` — the index, save, read,
  and the picker label.
- `lib/agents/agency-agent/lib/sessionTitle.agency` — the one-line title:
  from the first prompt on turn 1, then from the tail of the `main` thread
  every `TITLE_EVERY` turns. One LLM call in its own thread; fails open to "".
- `lib/agents/agency-agent/lib/resume.agency` — which session this run is
  (`chooseSession`, `startSession`), the restore, the per-turn record
  (`recordTurn`), and the footer text (`sessionTitle`).
- `lib/stdlib/agentSessions.ts` — the files, and `_sessionOnSubmit`, the
  REPL callback that checkpoints between turns.

## When the checkpoint is taken

Restoring a checkpoint resumes at the exact point it was taken, with the
saved call stack. The REPL loop is TypeScript, so a checkpoint taken inside
a turn (from the `onSubmit` callback) would carry the turn's own Agency
frame under a REPL invocation that no longer exists; on resume the runtime
would hand that frame to the next `onSubmit` call and the user's first line
would go into it.

So the checkpoint is taken between turns, from `_sessionOnSubmit`: after
`onSubmit` and `recordTurn` have returned, the stack is "REPL waiting at the
prompt", and that is what gets saved. On resume the replay reaches the
`repl(...)` call, which never finished, and starts the REPL fresh; the first
line is an ordinary new turn.

The `-i` seed turn runs before the REPL, so `saveSeedTurn` checkpoints in
Agency code there; on resume execution continues at the line after
`checkpoint()` and then starts the REPL.

## How a resume works

`startSession` restores the checkpoint in `main()`, after the process-level
setup and before `runSession`. The order matters: a restore replaces the
Agency execution state (the threads, every `let` global, the LLM options,
which `setLlmOptions` writes to the state stack) and continues from the saved
point, but it keeps TypeScript-side effects. The memory layer and the MCP
connections are such effects, they depend on model resolution and on reads of
`settings.json`, and those reads must happen before the policy handler exists
or they prompt. So a resumed run does the same setup as a fresh one, then
restores. On replay, `main`'s completed steps are skipped, the replayed
`handle` block in `runSession` installs the policy handler again, and the
REPL starts fresh.

The REPL's Agency callbacks are handed to `_sessionOnSubmit` through
TypeScript module state (`installSessionHooks`, before the restore), not as
an Agency value: a closure built by an Agency statement would be a completed
step in the checkpoint and come back from a restore as nothing.

### The transcript on resume

A resumed run prints the saved conversation before it restores. It is
read from the checkpoint file (`_readTranscript` in `agentSessions.ts`),
not from the restored threads, because `restore()` replays to the saved
point and runs nothing placed after it. The thread is the one the brain
opens with `thread(session: ...)`; each brain names it in its
`AgentBrain.session` field, and the title refresh reads the same thread.
`showTranscript` in `transcript.agency` draws the messages with the same
renderers the live turns use.

### `/rename`

`/rename <title>` sets the record's title, pins it so the periodic title
refresh leaves it alone, and marks the record dirty. `recordTurn` returns
a save target for a dirty record even when no turn ran, so the save that
follows every REPL line writes it.

Because the `let` globals come back from the saved run, `--model`,
`--policy`, and similar flags passed on a resume are ignored; the session
continues as it was left.

The zod schemas in `lib/runtime/state/schemas.ts` must name every field the
thread store serializes; a field missing there is dropped when the checkpoint
file is read back (see `docs/dev/runtime/checkpointing.md`).

## Not in v1

Forking, `/resume` inside a session, saving one-shot
(`-p`) runs, mid-turn crash recovery, and cleanup of old sessions.
