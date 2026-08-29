# Saved sessions: save and resume for `agency agent`

An interactive `agency agent` run is saved after every completed turn, and a
later run can pick it up with `--continue` or `--resume`. The saved thing is
a runtime checkpoint, not a transcript: the conversation, every subagent's
session thread, and the agent's `let` globals come back exactly as they were,
and execution resumes at the line after `checkpoint()`.

## Files

`<agent home>/sessions/<cwd slug>/` holds one `<id>.json` per session (the
checkpoint from `getCheckpoint`) and `index.json`, a list of session records
(`id, cwd, brain, created, lastActive, turns, title`) with the most recently
saved first. The agent home is `~/.agency-agent` or `AGENCY_AGENT_HOME`. The
slug is the working directory with every non-alphanumeric character replaced
by `-`, so sessions are per project directory, as in Claude Code.

## The three modules

- `lib/agents/agency-agent/lib/sessions.agency` — the files: list, find,
  save, load, and the picker label.
- `lib/agents/agency-agent/lib/sessionTitle.agency` — the one-line title:
  written from the first prompt on turn 1, rewritten from the `main`
  thread's text every `TITLE_EVERY` turns. One small LLM call in its own
  thread; fails open to "".
- `lib/agents/agency-agent/lib/resume.agency` — the glue: which session this
  run is (`chooseSession`, `startSession`), the per-turn save (`recordTurn`),
  the footer text (`sessionTitle`), and the checkpoint `runSession` restores
  (`takeResumeCheckpoint`).

## Where the checkpoint is taken, and why there

`recordTurn` runs in `repl.agency`'s `renderUserTurn`, after `runTurn`
returns. That is outside the per-turn `guard` and the budget handler, and it
is the one place that knows a turn fully completed. The title is refreshed
before `checkpoint()` so the saved globals carry it.

## How a resume works

1. `main()` runs its normal startup from today's flags: models, memory, MCP.
   `chooseSession` picks the record, `startSession` loads its checkpoint and
   queues it.
2. `runSession` installs the policy handler, runs `brain.init`, then calls
   `restore(cp, {})`. That throws `RestoreSignal`; the node runner replays
   `main` with the saved stack. Completed steps are skipped, so startup does
   not run twice, and the replayed `handle` block pushes the policy handler
   again.
3. Replay reaches `startInteractive`, whose `repl(...)` step never finished,
   so the TS REPL is called again fresh. The saved turn's `_runTurn` frame is
   still waiting below it: the runtime hands it to the next `onSubmit` call.
   That is why `repl` takes `drainFirst: true`: it calls `onSubmit("")` once
   before reading input. On a resume that call finishes the saved turn (which
   re-runs `saveSession`, harmlessly); on a fresh run "" is a no-op turn.
   Without the drain the user's first typed line would be swallowed.

What comes from the checkpoint: the threads (so `thread(session: "main")`
continues the saved conversation), every `let` global, and the resume point.
What comes from today's startup: anything set through TS side effects
(`setLlmOptions`, `enableMemory`, MCP connections) and the handlers. Note
that `let` globals include the model-slot cache and the policy module's
state, so `/model` and the explain view describe the saved run's choices
until the user changes them.

## Things that bit

- The zod schemas in `lib/runtime/state/schemas.ts` must name every field the
  thread store serializes, or a disk checkpoint silently loses them (PR #961).
- A `with approve` inside the session's policy handler does not stop that
  handler from prompting (every handler in the chain runs). The save runs
  inside `std::policy`'s `internalIo { }`, the flag the handler already uses
  for its own policy-file I/O.
- `read`/`write`/`exists` refuse an absolute path outside the cwd; pass the
  session directory as `dir` and keep file names relative.
- A `def` cannot be passed to a JS method such as `Array.sort`; keep the
  index ordered on write instead.
- `n.toString(36)` on a number crashes the typechecker
  (`validatePrimitiveMethodCall`, `sig.params` undefined); ids use decimal.

## Not in v1

Naming and renaming, forking, `/resume` inside a session, saving one-shot
(`-p`) runs, mid-turn crash recovery, and cleanup of old sessions.
