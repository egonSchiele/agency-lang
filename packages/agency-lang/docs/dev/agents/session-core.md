# The session core

The agent's conversation loop as a program any front-end can run. It
exists so a session can move between front-ends: start one with
`agency agent` in a terminal, carry on in an app.

**The terminal does not use it yet.** `agency agent` still runs its own
loop (`agent.agency`, `lib/runSession.agency`, `lib/repl.agency`). Today
the core is driven by tests.

Design: `docs/superpowers/specs/2026-11-18-shared-session-core-design.md`.

## Why a session can cross

A saved session is a paused program. It can be resumed only by a process
that has the same compiled code for every file with a frame on the saved
stack (`docs/dev/runtime/checkpoint-code-fingerprints.md`). So every
front-end runs one program and loads the same compiled files:

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

## The interface

**Start.** `main(start: ProgramStart)`: the brain, a preset, the model
flags, the tool limits, and a `SessionStart` (the working folder, a reply
style line, the session's record, and the flags the session facts list).
A setup that fails ends the run with the reason. The process is not
ended.

**The pause.** The core waits with one interrupt, `agent::sessionInput`.
Its data is what a front-end shows and saves between turns: `thread`,
`cwd`, `record`, `models`, `preset`, `budget`, `context`.

**Answers.** A front-end answers the pause with an `Answer`:

| Kind      | Fields                    | What the core does                                      |
| --------- | ------------------------- | ------------------------------------------------------- |
| `message` | `text`, `notes`, `target` | Runs a turn                                             |
| `model`   | `spec`                    | Switches models, as `/model`                            |
| `options` | `options`                 | Sets the session's LLM options, such as the temperature |
| `budget`  | `maxCost`, `maxTime`      | Sets the limits of later turns                          |

- `notes` are lines put above the message. An image is sent as a note
  with its path, since the turn finds attachments by scanning the message
  for paths.
- `target` is a start target such as `code`, or "" for the main agent.
  One the brain does not have is refused with a `session.error`, and is
  not a turn.

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
- **The `match` over an `Answer` has no `_` arm.** The type checker does
  not check an object union for a missing case yet (B2 in
  `docs/dev/compiler/typechecker/narrowing/README.md`). When it does, a
  `_` arm would hide the case it reports.
- **`options` is `any` in the `Answer`.** Checking a value against a type
  fills each optional field it lacks with null, and a null LLM option
  means "remove it".
- **No call inside the argument of a `try` call** (#1506). `try f(g(x))`
  runs `g` again when a paused run is resumed, and `g` takes the saved
  frame of `f`. The core and the REPL work the turn's message out on its
  own line, then call `try runTurn(...)`.
- **A model call that fails is a reply, not an error.** `answerTurn`
  turns it into the text "The agent stopped before finishing: ...".
  `session.error` is for a turn that throws outside `agencyAgent`.
- **The turn budget covers the main agent only.** It is applied where
  `agencyAgent` is called. A turn sent straight to a start target is not
  limited by it, and the core says so in a warning notice.
- **The effort has no answer.** It is not one of the `LlmOptions` keys:
  in the terminal it comes from `--effort` or a preset.
- **Starting a session does not save the search backend.** `main` calls
  `startModels(flags, false)`. The terminal does save it. An app's
  environment often lacks the search keys a terminal has, and a choice
  saved from there would follow the user back.
- **No job tools.** A background job belongs to the run and stops when
  the run pauses, and this run pauses after every turn.
- **The reply style and the job tools default to the terminal's.**
  `setInteractive` in `trace.agency` sets both, and the core sets both
  itself.

## The program reaches no terminal code

Loading a module runs its top-level code. `trace.agency` prints every
tool call from a top-level callback, so an app's engine must never load
it. `lib/stdlib/agentSessionImports.test.ts` walks the imports of
`program.agency` and fails if they reach:

- one of the terminal's modules: `agent.agency`, and in `lib/`: `repl`,
  `capabilitiesUi`, `mcpMenu`, `header`, `transcript`, `args`, `policy`,
  `trace`, `runSession`, `resume`, and `slashCommands/`;
- any module with a top-level `callback(`.

A line for the person is a notice (`lib/notice.agency`), which
`trace.agency` prints.

## What can still print or end the process

| Where | Why it is left |
| --- | --- |
| `session.agency`: `pickGuidedLocalModel`, `pickModelsForAgent`, `maybeEnableMemory`, `switchModel` | Terminal only. The core uses `startModels` and `applyModelSpec`. |
| `presets.agency`: `startPreset` | Terminal only. The core uses `startPresetQuiet`. |
| `shared.agency`: `configureLocalModel` | A local model that fails to load ends the process. |
| `settings.agency`, `capabilities.agency`, `globalInstructions.agency`, and `configureSearch` in `search.agency` | Startup warnings that `print`. In an app they reach the engine's log and no client. |
| `mcp.agency`: `maybeLoadMcp` | A front-end's own startup. The program does not call it. |

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
(`getAgentCwd()`). `tests/agency-js/session-core-handoff` runs both
processes in one folder, so it does not catch this.

**Local models.** A program started with `localModels: false` refuses a
local request, at the start or from a later answer, with "Local models
are not available here." An app whose one process holds every session
sets this. Where they are allowed, a local model that cannot be set up is
a failure too: nothing in the program ends the process.

**Each process sets up its own MCP servers** before it resumes a session.
Connections belong to the process.

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
