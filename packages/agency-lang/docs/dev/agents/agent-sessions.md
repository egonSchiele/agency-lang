# Saved sessions: save and resume for `agency agent`

An interactive `agency agent` run is saved after every completed turn, and a
later run can pick it up with `--continue` or `--resume`. The saved thing is
a runtime checkpoint, not a transcript: restoring it brings back the
conversation, every subagent's session thread, and the agent's `let`
globals, and execution continues at the line after `checkpoint()`.

## Files

`<agent home>/sessions/<cwd slug>/` holds one `<id>.json` per session (the
value of `getCheckpoint`) and `index.json`, a list of session records
(`id, cwd, brain, created, lastActive, turns, title`), most recently saved
first. The agent home is `~/.agency-agent` or `AGENCY_AGENT_HOME`. The slug
is the working directory with every non-alphanumeric character replaced by
`-`, so sessions are per project directory, as in Claude Code.

The file I/O is TypeScript (`lib/stdlib/agentSessions.ts`), like the REPL
history file: it is harness bookkeeping under the agent's own directory,
never a tool, so it raises no interrupt and the user's policy is not asked
about it.

## Modules

- `lib/agents/agency-agent/lib/sessions.agency` — the index, save, read,
  and the picker label.
- `lib/agents/agency-agent/lib/sessionTitle.agency` — the one-line title:
  from the first prompt on turn 1, then from the tail of the `main` thread
  every `TITLE_EVERY` turns. One LLM call in its own thread; fails open to "".
- `lib/agents/agency-agent/lib/resume.agency` — which session this run is
  (`chooseSession`, `startSession`), the per-turn save (`recordTurn`), the
  footer text (`sessionTitle`), and the checkpoint `runSession` restores.

## Where the checkpoint is taken

`recordTurn` runs in `repl.agency` after a turn's reply is rendered, both
for typed turns and for the `-i` seed turn. That is outside the per-turn
`guard` and the budget handler. The title is refreshed before
`checkpoint()` so the saved globals carry it.

## How a resume works

Restoring a checkpoint replaces the whole execution state with the saved
one, so where `restore()` is called decides what survives from the current
process. It is called inside `runSession`, after `main()` has run startup
from today's flags (models, memory, MCP) and after the policy handler is
installed:

1. `startSession` reads the chosen checkpoint file and queues it.
2. `runSession` installs the policy handler, runs `brain.init`, then
   `restore(cp, {})`. The node runner replays `main` with the saved stack;
   steps the checkpoint recorded as done are skipped, so startup does not
   run twice, and the replayed `handle` block installs the policy handler
   again.
3. Replay reaches `startInteractive`, whose `repl(...)` step never finished,
   so the REPL starts fresh. The saved turn's callback frame is still on the
   stack, and the runtime hands it to the next `onSubmit` call. `repl` takes
   `drainFirst: true` for this: it calls `onSubmit("")` once before reading
   input, which finishes the saved turn instead of letting the user's first
   line be consumed by it.

From the checkpoint: the threads, every `let` global, and the resume point.
From today's startup: state set through TypeScript side effects
(`setLlmOptions`, `enableMemory`, MCP connections) and the handlers. The
`let` globals include the model-slot cache and the policy module's state, so
`/model` describes the saved run's choices until the user changes them.

The zod schemas in `lib/runtime/state/schemas.ts` must name every field the
thread store serializes; a field missing there is dropped when the checkpoint
file is read back (see `docs/dev/runtime/checkpointing.md`).

## Not in v1

Naming and renaming, forking, `/resume` inside a session, saving one-shot
(`-p`) runs, mid-turn crash recovery, and cleanup of old sessions.
