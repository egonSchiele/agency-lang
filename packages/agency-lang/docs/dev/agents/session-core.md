# The session core

`agency agent` in a terminal and an app such as Perry are meant to be two
ways into the same sessions: start one in the terminal, carry on in the
app. The session core is what makes that possible. It is the agent's
conversation loop, written so that any front-end can run it.

Design: `docs/superpowers/specs/2026-11-18-shared-session-core-design.md`.

**The terminal does not use it yet.** `agency agent` still runs its own
loop (`agent.agency`, `lib/runSession.agency`, `lib/repl.agency`). Today
the core is driven by tests. Perry moves onto it next, then the terminal.

## Why a session can cross

A saved session is a paused program. It can be resumed only by a process
that has the same compiled code for every file with a frame on the saved
stack (`docs/dev/runtime/checkpoint-code-fingerprints.md`).

So both front-ends run one program, and load the same compiled files:

- **`lib/agents/agency-agent/program.agency`** is the program. `main`
  sets the session up from the data it is given, then goes to the core
  with `goto`.
- **`lib/agents/agency-agent/core.agency`** is the core: the node
  `session`.
- **`package.json` exports the compiled program** as
  `agency-lang/agent-session`. A front-end imports it in TypeScript and
  calls `main` and `respondToInterrupts`.

The export is the one public thing. The modules behind it are the agent's
own and can change.

`tests/agency-js/session-core-handoff` pauses a turn on an approval in one
process, and a second process that never ran `main` finishes it.

## The interface

**Start.** `main(start: ProgramStart)`: the brain, a preset, the model
flags, the tool limits, and a `SessionStart` (the working folder, a reply
style line, the session's record, and what the session facts say it was
started with). A setup that fails ends the run with the reason. Nothing
is printed and the process is not ended.

**The pause.** The core waits with one interrupt, `agent::sessionInput`.
Its data is what a front-end shows and saves between turns: `thread`,
`cwd`, `record`, `models`, `preset`, `budget`, `context`.

**Answers.** A front-end answers the pause with an `Answer`:

| Kind      | Fields                    | What the core does              |
| --------- | ------------------------- | ------------------------------- |
| `message` | `text`, `notes`, `target` | Runs a turn                     |
| `model`   | `spec`                    | Switches models, as `/model`    |
| `options` | `options`                 | Sets the session's LLM options, such as the temperature |
| `budget`  | `maxCost`, `maxTime`      | Sets the limits of later turns  |

`target` is a start target such as `code`, or "" for the main agent. One
the brain does not have is refused with a `session.error`, and is not a
turn.

`notes` are lines put above the message. A front-end sends an image as a
note with its path, since the turn finds attachments by scanning the
message for paths.

**Events**, through `emit`: `session.reply`, `session.error`,
`session.notice` (a line for the person, with a level), and
`session.budgetStop`.

**Approvals.** The core installs no policy handler and asks no one. The
policy is the run's own, passed as the `policy` option on `main` and on
every resume. What no rule decides leaves the run as an interrupt with a
checkpoint, and the front-end answers it.

## Things that are easy to get wrong

- **A front-end must pin the pause.** Its policy has to leave
  `agent::sessionInput` to `propagate`. Otherwise a `*` approve rule
  answers the pause with nothing.
- **An answer of nothing ends the session.** That is what a policy sends
  when it answers the pause. Raising again would get the same answer
  forever, without ever pausing, so the node returns.
- **An answer of the wrong shape is refused,** with a `session.error`,
  and the core pauses again. The answer is checked with `Answer!`.
- **The `match` over an `Answer` has no `_` arm.** The type checker does
  not check an object union for a missing case yet (B2 in
  `docs/dev/compiler/typechecker/narrowing/README.md`). When it does, a
  `_` arm would hide the case it reports.
- **`options` is `any` in the `Answer`.** Checking a value against a type
  fills each optional field it lacks with null, and a null LLM option
  means "remove it".
- **No call inside the argument of a `try` call.** `try f(g(x))` runs `g`
  again when a paused run is resumed, and `g` takes the saved frame of
  `f` ("Resume desync"). This is a compiler bug. The core works the
  turn's message out on its own line, then calls `try runTurn(...)`.
  `lib/repl.agency` has the old shape, `try runTurn("", withPendingNotes(msg))`.
  It is safe there only because the terminal never resumes in the middle
  of a turn, and has to change when the terminal moves onto the core.
- **A model call that fails is a reply, not an error.** `answerTurn`
  turns it into the text "The agent stopped before finishing: ...", and
  the core emits it as `session.reply`. `session.error` is for a turn
  that throws outside `agencyAgent`.
- **The turn budget covers the main agent only.** It is applied where
  `agencyAgent` is called. A turn sent straight to a start target is not
  limited by it, and the core says so in a warning notice.
- **The effort has no answer yet.** It is not one of the `LlmOptions`
  keys: in the terminal it comes from `--effort` or a preset. An app that
  wants an effort picker needs a new kind of answer.
- **Starting a session does not save the search backend.** `main` calls
  `startModels(flags, false)`, so the backend picked for the session is
  not written to `settings.json`. The terminal does save it. An app's
  environment often lacks the search keys a terminal has, and a choice
  saved from there would follow the user back.
- **No job tools.** A background job belongs to the run and stops when
  the run pauses, and this run pauses after every turn. The core turns
  the job tools off.
- **The reply style and the job tools default to the terminal's.**
  `setReplyStyle` and `setJobToolsOn` start "on", and `setInteractive` in
  `trace.agency` sets both. The core sets both itself.

## The program reaches no terminal code

Loading a module runs its top-level code. `trace.agency` prints every
tool call from a top-level callback, so an app's engine must never load
it. `lib/stdlib/agentSessionImports.test.ts` walks the imports of
`program.agency` and fails if they reach any of the terminal's modules:
`agent.agency`, and in `lib/`: `repl`, `capabilitiesUi`, `mcpMenu`,
`header`, `transcript`, `args`, `policy`, `trace`, `runSession`,
`resume`, and `slashCommands/`.

Three splits keep it true:

- `lib/record.agency` holds the session record. `lib/resume.agency` keeps
  the terminal's picker and restore.
- `lib/runSession.agency` holds the terminal's policy wrapper. It was in
  `lib/turn.agency`.
- A line for the person is a notice (`lib/notice.agency`), which
  `trace.agency` prints.

## What can still print or end the process

| Where | Why it is left |
| --- | --- |
| `session.agency`: `pickGuidedLocalModel`, `pickModelsForAgent`, `maybeEnableMemory`, `switchModel` | Terminal only. The core uses `startModels` and `applyModelSpec`. |
| `presets.agency`: `startPreset` | Terminal only. The core uses `startPresetQuiet`. |
| `shared.agency`: `configureLocalModel` | A local model that fails to load ends the process. Not handled yet. |
| `settings.agency`, `capabilities.agency`, `globalInstructions.agency`, and `configureSearch` in `search.agency` | Startup warnings that `print`. In an app they reach the engine's log and no client. |
| `mcp.agency`: `maybeLoadMcp` | A front-end's own startup. The program does not call it. |

The runtime also logs `Node main crashed` to stderr when a setup fails.

## Not solved yet

**The program reads the process's folder where it should read the
session's.** These use the process's `cwd()`, and the first two run when
the modules load:

| File | What it reads |
| --- | --- |
| `lib/claudeSkills.agency` | The Claude skills under `cwd()` |
| `lib/commandPalette.agency` | `${cwd()}/.claude/commands`, and the init file |
| `lib/sessions.agency` | `projectDir()`, the folder a session is saved under |

In the terminal the two folders are the same. An engine that runs every
session from one folder gives each session that folder's commands and
skills. Each read has to become a function of the session's folder
(`getAgentCwd()`). The handoff test runs both processes in one folder, so
it does not catch this.

**Each process sets up its own MCP servers** before it resumes a session.
Connections belong to the process.

## The terminal: what the check found

Not run yet. The check is whether `repl()` works over a session run on a
real terminal: the pinned approval prompt, Esc, the turn's footer and
Ctrl+D. It needs a person at a terminal. The program for it is on the
branch `spike/run-in-run`, in `spike-run-in-run/shell.agency`.

## Files

| File | Job |
| --- | --- |
| `lib/agents/agency-agent/core.agency` | The core: `session`, `Answer`, `SessionStart`, the pause's data. |
| `lib/agents/agency-agent/program.agency` | The program: `main`, `ProgramStart`. |
| `lib/agents/agency-agent/lib/record.agency` | The session record, the turn count, the title, the thread. |
| `lib/agents/agency-agent/lib/notice.agency` | `notice`. |
| `lib/stdlib/agentSessionImports.test.ts` | The import rule. |
| `tests/agency-js/session-core` | The core, driven as a front-end drives it. |
| `tests/agency-js/session-core-handoff` | A second process finishes a paused turn. |
