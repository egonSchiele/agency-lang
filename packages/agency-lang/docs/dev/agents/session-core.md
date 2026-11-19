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
style line, the session's record, the flags the session facts list, and
the starting turn budget). `start` is checked against its type, so a
front-end built for another version is refused with the field that does
not fit. A setup that fails ends the run with the reason. The process is
not ended.

**The pause.** The core waits with one interrupt, `agent::sessionInput`.
Its data is what a front-end shows and saves between turns: `thread`,
`cwd`, `record`, `models`, `preset`, `fixedProvider`, `effort`, `budget`,
`context`.

- `effort` is what the session asks for: a level, `default` to send none,
  or "" when no one named one and the models' own rule decides.
- `fixedProvider` is the provider the session is fixed to, by the name a
  person sees, or "". `--provider`, a preset that names a provider, or
  `settings.model` fixes one.

**Answers.** A front-end answers the pause with an `Answer`:

| Kind      | Fields                    | What the core does                                      |
| --------- | ------------------------- | ------------------------------------------------------- |
| `message` | `text`, `notes`, `target` | Runs a turn                                             |
| `model`   | `spec`                    | Switches models, as `/model`                            |
| `options` | `options`                 | Sets the session's LLM options, such as the temperature |
| `budget`  | `maxCost`, `maxTime`      | Sets the limits of later turns                          |
| `effort`  | `effort`                  | Sets the reasoning effort. It outlasts a model switch   |
| `preset`  | `name`                    | Switches to a saved preset, whole, as `/preset`         |

A `model`, `effort` or `preset` answer the core cannot apply changes
nothing and sends a `session.notice` at level `error` with the reason.

- **A model's provider.** With no provider fixed, `openai/gpt-4o` switches
  to OpenAI. With one fixed, the spec is read whole, as a model of that
  provider, which is how an OpenRouter model keeps its slash. A front-end
  reads `fixedProvider` to know which it will get.
- **A preset replaces the session's own choices:** its models and its
  effort. The preset's effort is then the one in force.

- `notes` are lines put above the message. An image is sent as a note
  with its path, since the turn finds attachments by scanning the message
  for paths.
- `target` is a start target such as `code`, or "" for the main agent.
  One the brain does not have is refused with a `session.error`, and is
  not a turn.

**Events**, through `emit`: `session.reply`, `session.error`,
`session.notice` (a line for the person, with a level),
`session.budgetStop`, and `session.editDiff` (one file edit's `filename`,
`edits` and `hunks`).

**Approvals.** The core installs no policy handler and asks no one. The
policy is the run's own, passed as the `policy` option on `main` and on
every resume. What no rule decides leaves the run as an interrupt with a
checkpoint, and the front-end answers it.

**Edit diffs.** The core's one handler around a turn reports every
`std::edit` as a `session.editDiff` event and then passes. It never
approves and never rejects. A handler sees an edit even when the run's
policy answers it, so an edit a rule approves has a diff too. A front-end
makes the diff on an approval with the same function
(`agency-lang/stdlib-lib/editDiff.js`), so the two cannot differ.

## Things that are easy to get wrong

- **A front-end must pin the pause.** Its policy has to leave
  `agent::sessionInput` to `propagate`. Otherwise a `*` approve rule
  answers the pause with nothing. The session driver
  (`session-driver.md`) pins it in every policy it gives a run.
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
- **The effort is not an LLM option.** It is not one of the `LlmOptions`
  keys, so an `options` answer cannot set it. It has its own answer.
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
| `settings.agency`, `capabilities.agency`, `globalInstructions.agency`, and `configureSearch` in `search.agency` | Startup warnings that `print`. In an app they reach the engine's log and no client. |
| `mcp.agency`: `maybeLoadMcp` | A front-end's own startup. The program does not call it. |

## The session's folder

The user's own files are read from the folder the session started in
(`lib/sessionFolder.agency`): `.claude/commands`, the Claude skills, and
the folder its saved sessions are kept under. The core sets it from
`start.cwd`. The agent's working folder (`getAgentCwd`) starts there too,
but a coder moves it, and these reads do not follow it.

A terminal scans once in `runSession`, before it installs its policy
handler, and keeps the result for the process
(`lib/stdlib/agentFolderScans.ts`). A scan made under that handler would
be put to the user, or rejected in a `-p` run.

## What an engine sets for its process

A process that holds many sessions calls two setters once, when it
starts, before any session runs (`agency-lang/stdlib-lib/agentProcess.js`).
They describe the process, so they are not saved with a session.

- `_setManySessions(true)`: nothing is kept in the process for one session
  that another could read. Each read of a folder's commands and skills is
  a scan, with its own `with approve`, that the run's policy is asked
  about.
- `_setLocalModelsAllowed(false)`: see below.

Both default to the terminal's answer. An engine that forgets one gets no
error, so its own tests should check both: a command added while it runs
is seen, and a local preset is refused.

## Local models

Whether a process can host a local model is a fact about the process, not
the session. After `_setLocalModelsAllowed(false)`, a local request is then refused with "Local models are
not available here.": `--local`, a local preset, or a model spec that
names a local provider such as `mlx/…`.

## Not solved yet

**Each process sets up its own MCP servers** before it resumes a session.
Connections belong to the process.

## Files

| File | Job |
| --- | --- |
| `lib/agents/agency-agent/core.agency` | The core: `session`, `Answer`, `SessionStart`, the pause's data. |
| `lib/agents/agency-agent/program.agency` | The program: `main`, `ProgramStart`. |
| `lib/agents/agency-agent/lib/record.agency` | The session record, the turn count, the title, the thread. |
| `lib/agents/agency-agent/lib/notice.agency` | `notice`. |
| `lib/agents/agency-agent/lib/sessionFolder.agency` | The folder a session started in. |
| `lib/stdlib/agentFolderScans.ts` | The scans a terminal keeps. |
| `lib/stdlib/agentProcess.ts` | What an engine sets for its process. |
| `lib/stdlib/editDiff.ts` | An edit's hunks, for the core and for a front-end. |
| `lib/stdlib/agentSessionImports.test.ts` | The import rule. |
| `tests/agency-js/session-core` | The core, driven as a front-end drives it. |
| `tests/agency-js/session-core-folders` | Two sessions in two folders in one process. |
| `tests/agency-js/session-core-handoff` | A second process finishes a paused turn. |
