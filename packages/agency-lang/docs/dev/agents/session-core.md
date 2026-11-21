# The session core

The agent's conversation loop as a program any front-end can run. It
exists so a session can move between front-ends: start one with
`agency agent` in a terminal, carry on in an app.

`agency agent` runs every session on it, interactive and `-p` alike,
through the session driver (`docs/dev/agents/session-driver.md`, "The
terminal"). Perry runs it too.

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

Three fields of `ProgramStart` are optional, so a start that sends none
of them is not refused:

- `agentName` is the name the run's statelog groups it under, such as
  `agency-agent/coordinator` (what the terminal sets). `main` calls
  `setAgentName` with it. Left out or "", none is set. A name that is not
  a valid statelog name ends the run with the reason.
- `oneShot` is true for a run that takes one message and ends, as
  `agency agent -p`. `main` gives it to `applyToolLimits`, so such a run
  gets 100 tool rounds by default and a session 50. Left out, it is false.
- `trace` is `{ debug, verbose, interactive }`, what the run shows of its
  work. Only a process that loaded the terminal's `trace.agency` prints
  anything: its callbacks fire in every run and read these flags from
  the run they fire in (`lib/traceSettings.agency`). Each run has its own,
  so two sessions in one process can differ. Left out: debug from
  `AGENT_DEBUG`, not verbose, and interactive.

**The pause.** The core waits with one interrupt, `agent::sessionInput`.
Its data is what a front-end shows and saves between turns: `thread`,
`cwd`, `record`, `models`, `preset`, `presetChanges`, `fixedProvider`,
`effort`, `budget`, `context`, `brain`, `search`.

- `search` is the web search backend in force: `hosted`, `tavily`,
  `brave` or `off`. The driver reads it as "" from a pause that lacks it.
- `brain` is the name of the brain that runs the session. `record.brain`
  holds it too, but a session that is not saved has no record. A front-end
  reads the brain from this field only.
- `effort` is what the session asks for: a level, `default` to send none,
  or "" when no one named one and the models' own rule decides.
- `fixedProvider` is the provider the session is fixed to, by the name a
  person sees, or "". `--provider`, a preset that names a provider, or
  `settings.model` fixes one.
- `presetChanges` is what the session changed from its preset as it took
  it, one line a field in `/preset save`'s words, trimmed, such as
  `effort: (none) → low` (`presetChanges` in `lib/session.agency`). It
  compares with a snapshot of the startup flags and the preset with no
  choices, taken at start (`notePresetBaseline`), at each switch, and
  after a save to the active preset. Not with the preset as saved: a
  saved preset's form (a bare `pin`) can differ from a snapshot's while
  meaning the same models, and a startup flag such as
  `--max-tool-rounds` is in the snapshot on both sides, so neither shows
  as a change. It reads only memory. It is empty with no active preset (a
  deleted one is no longer active) and after `/local`. A session resumed
  from a version that kept no snapshot reports none until its next pick
  or save. A front-end offers Save as a `savePreset` answer naming the preset, and
  Revert as a `preset` answer with the same name. Changes under a preset
  are not kept for new sessions (agent-presets.md, "The last settings").
  The terminal does not draw this field yet. The driver reads it as `[]`
  from a pause that lacks it.

**Answers.** A front-end answers the pause with an `Answer`:

| Kind         | Fields                    | What the core does                                                   |
| ------------ | ------------------------- | -------------------------------------------------------------------- |
| `message`    | `text`, `notes`, `target` | Runs a turn                                                          |
| `model`      | `spec`                    | Switches models, as `/model`                                         |
| `options`    | `options`                 | Sets the session's LLM options, such as the temperature              |
| `budget`     | `maxCost`, `maxTime`      | Sets the limits of later turns                                       |
| `effort`     | `effort`                  | Sets the reasoning effort. It outlasts a model switch                |
| `preset`     | `name`                    | Switches to a saved preset, whole, as `/preset`                      |
| `compact`    | `keep`                    | Summarizes the older messages now, as `/compact <keep>`              |
| `rename`     | `title`                   | Gives the session a title, as `/rename`                              |
| `fork`       | none                      | Makes the session a copy with a new `record.id`, as `/fork`          |
| `search`     | `backend`                 | Switches the web search backend and saves it, as `/search`           |
| `savePreset` | `name`                    | Saves the session to a preset, "" for the active one, as `/preset save` |
| `local`      | `model`                   | Runs the session on a local model, as `/local`                       |
| `capabilities` | `settings`              | Saves one capability override and applies it, as `/settings`         |

An answer the core cannot apply changes nothing and sends a
`session.notice` at level `error` with the reason. What one that worked
did is a notice at level `info`, except a `model`, `options`, `budget`,
`effort` or `preset` answer, which the next pause shows.

- **`compact`** calls the model for the summary, in a hidden thread. With
  nothing older than the part a compaction keeps, it is refused with
  "Nothing to compact yet." A summary that fails is a `warning` notice,
  as an automatic compaction's is. `keep` is what the user asked the
  summary to keep, or "".
- **`rename` and `fork`** need a saved session, and a fork needs a turn.
  `renameSession` and `forkSession` (`lib/record.agency`) return facts:
  `success({ title })`, `success({ id, forkedFrom })`, or a failure of
  `"not saved"`, `"empty title"` or `"no turns"`. The core words its own
  notices, and the terminal its own lines
  (`lib/slashCommands/session.agency`). After a fork the pause's record
  has the new id and `forkedFrom`. A front-end saves the session under the
  new id, and the original stays as it was last saved. The hold moves too:
  every later `stillHeld` and `takeHold` uses the new id, and a front-end
  that keeps sessions by id (Perry's engine) keys this one by it. A
  session with a policy file of its own keeps that policy: the front-end
  saves it for the new id (`saveCarriedPolicy`).
- **`search`** refuses a name that is no backend, and a backend this
  session cannot use: `hosted` on a local model, `tavily` or `brave`
  without its key. The choice is saved to `settings.json`, as `/search`
  saves it (`switchSearchBackend` in `lib/search.agency`).
- **`search` and `savePreset` ask no one about their writes.** Each writes
  the user's settings as a direct result of a command the user gave, so
  the core approves the write itself with `with approve`. A rule in the
  run's policy still decides first.
- **`savePreset`** is `refreshAndSavePreset` in `lib/session.agency`,
  then `writeSessionPreset`. A save it refuses, such as one with no name
  and no active preset, is the error notice. The lines that say what was
  saved are one `info` notice.
- **`preset` and `savePreset` read the presets again first**
  (`refreshPresetTable`, approved by the core with `with approve`, as the
  save's write is). A run reads `settings.json` once at start, and another
  session or the terminal may have saved or deleted a preset since: a
  pick gets the preset as saved now, and a save compares against it. A
  file that can't be read leaves the run's copy. A save naming the
  preset that was active, which the read shows deleted, is refused with
  "The '<name>' preset was deleted, so there is nothing to save to.",
  rather than creating it again. So a box out of date can't bring back a
  deleted preset. `recommended` approves reads of `settings.json` in the
  agent home (`settingsReadRule`). Under `minimal`, or a policy with no
  rule for that file, a pick now asks, as a save always did.
- **`local`** is `useLocalModel` in `lib/session.agency`: the model the
  `/local` picker chose, a catalog name, an `hf:` URI or a `.gguf` path. A
  process that cannot host a local model refuses it with "Local models are
  not available here." Only the terminal sends it.
- **`capabilities`** carries one change `/settings` picked: `{ scope,
  field, value }`, where `scope` is `model`, `provider` or `global`, and a
  null `value` removes the override. `applyCapabilityChange` in
  `lib/capabilityChange.agency` saves it to `settings.json`, resolves the
  profile again, and applies what it can now: a new `maxTokens` cap, or
  memory turned off. A value the field can't take is refused. Every pause
  reports the profile as `capabilities` (`capabilityReport`), which the
  `/settings` screen draws. Only the terminal sends it.

- **A model's provider.** `openai/gpt-4o` names a known provider, so with
  no provider fixed it switches to OpenAI.
  - With a provider fixed, the spec is read whole, as a model of that
    provider. That is how an OpenRouter model keeps its slash. A
    front-end reads `fixedProvider` to know which it will get.
  - A provider found from an API key fixes nothing. Some providers' own
    model names hold a slash: OpenRouter's `z-ai/glm-5.2`, LiteLLM's
    `azure/gpt-4o`. On such a session the spec is read whole too.
  - Otherwise a spec whose part before the first `/` is not a known
    provider is refused. On an anthropic session, `groq/llama-3` gives
    `Unknown provider: groq. Known: ...`.
  - `takesSlashModelNames` in `lib/models.agency` says which providers
    take slash names: any without built-in defaults, and any whose
    defaults hold a slash.
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
checkpoint, and the front-end answers it. The core never holds a
session's own policy, so neither a checkpoint nor an interrupt's data
can change it: a front-end reads it from the session's policy file and
builds the run's policy from it (`session-driver.md`).

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
- **The job tools are offered.** A background job is a process of its
  own and outlives the turn, and the pause, that started it. The run's
  list of held jobs is saved in every checkpoint, so the next turn reads
  them (`docs/dev/stdlib/jobs.md`).
- **The reply style defaults to the terminal's.** `setInteractive` in
  `trace.agency` sets it, and the core sets it itself.

## The program reaches no terminal code

Loading a module runs its top-level code. `trace.agency` prints every
tool call from a top-level callback, so an app's engine must never load
it. `lib/stdlib/agentSessionImports.test.ts` walks the imports of
`program.agency` and fails if they reach:

- one of the terminal's modules: `agent.agency`, and in `lib/`: `repl`,
  `capabilitiesUi`, `mcpMenu`, `header`, `transcript`, `args`, `policy`,
  `trace`, `resume`, `terminal`, and `slashCommands/`;
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

The terminal's shell run scans once for its slash palette, before it
installs its policy handler, and keeps the result for the process
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

**The agent's own scans.** The core's scans of what the agent learned
(`<agent-home>/skills` by `std::skills`, `<agent-home>/tools` by
`std::toolbox`) are approved by the core itself, with `with approve` on
those calls only (`lib/learned.agency`). A policy with no rules asks
nothing about them, so a front-end needs no rule for them.

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
| `tests/agency-js/session-core-handoff` | A second process finishes a paused turn, and runs a session under its own policy file. |
