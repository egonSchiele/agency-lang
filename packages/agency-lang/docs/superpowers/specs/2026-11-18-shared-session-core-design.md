# A shared session core for `agency agent` and Perry

A draft for discussion, written 2026-11-18. Nothing here is built except
the two spikes named under "What we know works".

## The goal

Start a session with `agency agent` in a terminal and carry on in Perry's
Mac app, or the other way round. Either program can resume a session the
other saved, at a message or in the middle of a turn.

Today neither can. A saved session is a paused program, and it can be
resumed only by a program that has the same compiled code for every file
with a frame on the saved stack:

- An `agency agent` session is paused inside `agent.agency`,
  `turn.agency`, `repl.agency` and `std::ui/cli`. That is the terminal
  front-end itself.
- A Perry session is paused inside Perry's own `core.agency`.

The fix is one **session program** that both run. It is an Agency program
with no terminal code in it, kept in the agent's folder and exported from
the agency-lang package. It owns the conversation loop. A front-end starts
it from TypeScript, answers its questions, and listens to its events. Both
front-ends load the same compiled files, so a session either one saved is
a file the other can resume.

## The approach: extract the core from `agency agent`

`agency agent` is the superset, so the core is taken out of it. Perry's
`core.agency` is deleted and Perry uses the same core.

This is not a rewrite of the agent, and no module moves. The agent's
10,033 lines of Agency stay in `lib/agents/agency-agent/`. What changes:

- **Seven imports are untangled,** so the session program's imports reach
  no terminal code.
- **About ten mid-session terminal calls become events.** The other
  terminal calls in the shared modules are startup code that only the
  terminal runs.
- **New code:** the core node (100 to 150 lines), the session program
  around it, one export in `package.json`, and later the terminal's
  driver and the session file's format.

An earlier draft moved 45 modules into the standard library. That would
have made the agent's internals public `std::` modules, with generated
docs, that a user's program could import and depend on. The export avoids
that: the one public thing is the program.

Old sessions are not kept. A session saved before this change cannot be
resumed after it, by either program.

## The pieces

```
 agency agent (terminal)                  Perry
 ┌───────────────────────────┐            ┌─────────────────────┐
 │ shell run: repl(), pickers│            │ engine (TypeScript) │
 │ and approval prompts      │            │ and its clients     │
 │ driver (TypeScript)       │            │                     │
 └────────────┬──────────────┘            └──────────┬──────────┘
              │      answers, and events back        │
              └──────────────────┬───────────────────┘
                                 ▼
                  agency-lang/agent-session  (one program)
                  main: setup from data, then goto session
                  session: loop { pause → turn or command → events }
```

- **The core** is the node `session` in
  `lib/agents/agency-agent/core.agency`.
- **The session program** is `lib/agents/agency-agent/program.agency`.
  Its `main` does the setup from the data it is given, then
  `goto session(...)`. It is exported as `agency-lang/agent-session`.
- **A front-end** imports the compiled program in TypeScript, starts it,
  answers each pause, saves the session, and draws the events.

Checked: the compiled agent modules load from another package
(`import` of `turn.js` out of Perry's installed agency-lang 0.41.3), they
export `respondToInterrupts`, and their module ids do not depend on where
they are loaded from.

## The core's interface

### Starting: setup from data, then `goto`

`main` takes everything as data, so one program serves both front-ends.
It calls the setup functions the agent's `main` calls today, in versions
that return a failure where today's print and exit:

```ts
type ProgramStart = {
  brain: string;       // "" for the user's default
  preset: string;      // a preset's name, or ""
  models: ModelFlags;  // the startup model flags
  limits: LimitFlags;  // the startup tool limits
  session: SessionStart
}

type SessionStart = {
  cwd: string;                  // the folder the agent works in
  replyStyle: string;           // a line on how to format replies, or ""
  record: SessionRecord | null; // null for a session that is not saved
  flags: Record<string, any> | null  // the flags the session facts list, or null
}
```

- **A setup that fails ends the run** with the reason, and nothing is
  printed. The terminal prints it and exits. Perry shows it.
- **`main` does not pause.** Reads it needs are approved in place, as the
  agent's startup does now.
- **Memory is turned off in the run.** `disableMemory` changes the run's
  own stack, so `main` calls it.
- **`flags` is a record, and the core turns it into text.** The terminal
  passes its command-line flags and an app passes null. The session facts
  sit above the user-message boundary, so a free string there would make
  it easy to pass user text by mistake.

### The pause

The core waits with one interrupt, `agent::sessionInput`. Its data is what
a front-end shows and saves between turns:

```ts
{
  thread: string;          // the conversation's thread id
  cwd: string;             // the agent's working folder now, which a coder can move
  record: SessionRecord | null;  // id, cwd, brain, title, turns, forkedFrom
  models: Record<string, Resolved>;  // the resolved slots: main, reasoning, router
  preset: string;          // the active preset's name, or ""
  budget: { maxCost: number; maxTime: number };  // one turn's limits
  context: string          // how full the conversation's window is
}
```

The record is a global in the core, as it is in the agent now, so the
checkpoint holds it. It is also in the pause's data because the front-end
writes `<id>.meta.json` and cannot read a global.

Every front-end's policy pins `agent::sessionInput` to `propagate`, as
Perry pins `perry::userMessage` today, so a `*` rule cannot answer it.
The core also protects itself. A run policy that answers the pause sends
`null`, and the core treats `null` as "end the session" and returns.
Otherwise it would raise again forever without pausing.

### Answers

A pause is answered with one of these. The value is checked against the
type (`Answer!`), so a wrong shape is refused where it arrives. The
`match` over the kinds is not checked for a missing case yet: the type
checker does not cover object unions (B2 in
`docs/dev/compiler/typechecker/narrowing/README.md`). The `match` has no
`_` arm, so the check applies the day it exists.

| Kind       | Fields                         | What the core does                                 |
| ---------- | ------------------------------ | -------------------------------------------------- |
| `message`  | `text`, `notes`, `target`      | Runs a turn                                        |
| `model`    | `spec`                         | `switchModel`, as `/model <spec>` does             |
| `preset`   | `name`                         | `switchPreset`                                     |
| `options`  | `options`                      | Sets LLM options for later turns (temperature, routing) |
| `budget`   | `maxCost`, `maxTime`           | Sets one turn's limits                             |
| `compact`  | `instructions`                 | Compacts the conversation                          |
| `rename`   | `title`                        | Sets and pins the title                            |
| `fork`     |                                | Gives the run a new record                         |
| `search`   | `backend`                      | Picks the web search backend                       |
| `reload`   |                                | Reads `settings.json` again, after `/settings` changed it |

- **A front-end builds answers. The core parses no built-in command.**
  The terminal turns `/model opus` into `{ kind: "model", spec: "opus" }`.
  Perry's settings panel sends the same answer. Skill and user slash
  commands are still expanded in the core, since they are message text.
- **Asking stays in the front-end.** `/model` with no argument opens a
  picker in the terminal, and the pick is sent as the answer. The pickers
  read what they list from the pause's data.
- **`notes`** are lines put above the message, such as the output of a
  `!` shell command the user ran. The front-end runs the command and
  sends the note. An image is sent the same way, as a note with its
  path: the turn finds attachments by scanning the message for paths.
  `target` is the `--agent` start target, or "".
- **After every turn the core compacts the conversation when it is due,**
  as the REPL does now, and says so in notices.
- **A turn that fails** emits `session.error`, is counted as a turn, and
  the core pauses again.
- **Commands with no answer** stay in the front-end: `/help`, `/clear`,
  `/clear-history`, `/cost`, `/exit`, `/policy`, `/mcp`, `/models`.
  They change the process or the user's files, or only draw.
- **`/settings` is both.** The front-end edits `settings.json`, then
  sends `reload` so the run uses the new values.
- **`/jobs` is removed** with background jobs. See "Left out".

Perry's one `settings` answer goes away. Its panel sends `model`,
`options` and `budget`. The effort is not an LLM option in the agent (it
comes from `--effort` or a preset), so it has its own answer, `effort`,
and a preset has `preset`. Both were added with Perry's plan.

### Events

The core prints nothing. It reports through `emit`:

| Event                 | Fields               | When                                          |
| --------------------- | -------------------- | --------------------------------------------- |
| `session.reply`       | `text`               | A turn's reply                                |
| `session.error`       | `message`            | A turn failed, or an answer could not be read |
| `session.notice`      | `text`, `level`      | A line the agent prints today with `pushMessage` |
| `session.budgetStop`  | `label`, `dimension` | A budget ran out                              |

`agencyAgent.subagentStart` and `agencyAgent.routerFailed` pass through
as they are. Tool calls and model calls reach a front-end through the
runtime callbacks, as now.

### Approvals

The core installs no policy handler and asks no one. This replaces the
`handle ... with cliPolicyHandler` in `runSession`.

- **The policy is the run's invocation policy,** passed on `main` and on
  every resume. It answers what a rule matches, inside the run.
- **What no rule matches leaves the run** as an interrupt with a
  checkpoint, and the front-end answers it.
- **The core keeps one handler of its own,** the budget stop. Reads of
  `AGENTS.md` and `CLAUDE.md` need none: the function that reads them
  approves its own reads, and a reject rule in the run's policy still
  wins. Perry's edit diffs add a second handler when Perry moves over.

This is the choice that keeps a later fix for background jobs out of the
core: the core only raises, and who answers is decided where the run is
invoked.

## The saved session

One format for both programs, read and written by functions in
agency-lang:

```
<home>/sessions/<folder slug>/
  <id>.json        the pause: its interrupts, each with its checkpoint
  <id>.meta.json   the SessionRecord
```

- **`<id>.json` changes for the agent.** It holds a checkpoint today. It
  becomes the paused run, which is what Perry saves now (`SavedRun`). That
  type and its checks move from Perry into agency-lang.
- **The front-end saves at every pause,** with the record from the
  pause's data. So a session is saved while it waits on an approval too,
  which the agent does not do today.
- **`brain` is the real brain.** `brain: "perry"` goes away, and each
  program lists every session.
- **The turn count and the title are kept by the core,** after each turn,
  as `recordTurn` does now.

## The terminal front-end

The agent keeps `repl()` and its prompt code. It runs as two runs in one
process:

- **The shell run** is never saved. It parses the flags, picks the
  session, and calls `repl()`. Pickers and approval prompts run here, in
  Agency, where `chooseOption` and the pinned prompt already work.
- **The session run** is the session program. A TypeScript driver starts
  or resumes it, and the shell's `onSubmit` hands each line to the
  driver.

For one line, the driver sends the answer, draws events as they arrive,
and when the run pauses on an approval calls the shell's prompt and
resumes with the result. It saves at each pause.

What changes outside the agent's folder:

- **`cli.ts`**: Esc aborts the session run's leg, and the turn's footer
  reads the session run's token counts. Both point at the shell's run
  today.
- **`std::policy`**: the half that asks a person and saves the rule is
  exported apart from `cliPolicyHandler`.

One-shot runs (`-p`) go through the core too, with a driver that sends
one message and declines what no rule decides. That leaves one path for
approvals.

## Perry

- `src/agency/core.agency`, `answers.agency` and `perry.agency` are
  deleted. The engine imports `agency-lang/agent-session`.
- The engine sends the new answers and reads the new pause data. Its
  state machine, its wire format's shape and its approval flow stay.
- Edit diffs: `reportEdit` and its `perry.editDiff` event are in Perry's
  core today. They move into the shared core as `session.editDiff`, so
  the terminal can use them too.

## Each process's own setup

A resume does not run `main`. What a process must do before it resumes a
session:

- **MCP.** Connections belong to the process. Each front-end configures
  its servers first. The turn reads the tools with `getMcpTools()`, which
  finds the process's own.
- **`static` values** are set when the modules load.
- **Nothing for models, options, memory or the working folder.** They are
  run state and come back from the checkpoint. So flags such as `--model`
  on a resume are ignored, as they are today.

**A problem here that is not solved yet.** Three things are read from the
process's folder, not the session's: the user's `.claude/commands`, the
Claude skills (both in `static` values, set when the modules load), and
the folder a session is saved under. For the terminal the two folders are
the same. Perry's engine runs every session from one folder, so each
session would get the engine folder's commands and skills, at a fresh
start and after a handoff. Each read has to become a function of the
session's folder. That is the first task of Perry's plan.

## What a handoff carries

Carried, because it is run state in the checkpoint: the conversation and
every subagent's thread, the brain, the models of every slot, the preset,
the LLM options, the turn budget, the tool limits, the search backend,
the working folder, the record, and the cost so far. The runtime also
saves a `--max-cost` or `--max-time` root budget in the checkpoint. That
it is enforced after a resume in another program is not tested.

Shared, because it is a file in the agent home: saved presets,
`settings.json`, `policy.json`, learned tools and skills, MCP config.

Not carried:

- **MCP connections.** Each process connects its own, and asks again
  unless a saved rule approves.
- **`--policy`, `--approve` and `--reject`.** The policy is given by the
  front-end that runs the leg. A session started under `--policy minimal`
  runs under the shared `policy.json` once Perry resumes it. See the open
  questions.
- **The process's environment.** A model whose API key the terminal has
  and the engine lacks fails after the handoff.
- **Front-end flags and state:** `--verbose`, `--debug`, input history.

## What we know works

- **A pause in a shared node resumes in another program,** at a message
  and in the middle of a model's tool call (Perry's experiments, PR #5).
- **`repl()` works over a session run on a real terminal.** Checked by
  hand on 2026-11-19 with `spike-run-in-run/shell.agency` on the branch
  `spike/run-in-run`: a line reached the core and its reply was printed,
  the pinned approval prompt was drawn in the shell's run and its answer
  reached the core, Esc during a turn returned to the prompt, and Ctrl+D
  exited cleanly. The turn's footer was not tested: the check passed no
  `status` callback, and the footer prints nothing without one. So the
  terminal can keep `repl()` and its prompt code.
- **One run can drive another** (the spike on `spike/run-in-run`). A
  front-end run drove a core run through a turn, an approval answered by
  the front-end's Agency code, and an abort mid-turn. The front-end's
  handlers never saw the core's interrupts. A fresh process then resumed
  the saved pause through a second program.
- **Every module's globals are in a checkpoint,** and a resume restores
  them without running their initializers again (read in
  `globalStore.ts`).

## Not verified yet

1. **The slash palette and the turn's footer over a session run.** The
   footer's token counts are read from the shell's run, so they would
   show none of the core's usage.
2. **The size of the `cli.ts` change** for the footer.
3. **Top-level `callback(...)` blocks.** `trace.agency` prints tool calls
   from them. Whether they fire for a session run that a fresh process
   only resumes is not known. If not, the driver passes the callbacks.
4. **The modules the session program imports,** which I sorted by their
   imports and terminal calls without reading each in full.

## Left out

- **Background jobs.** The core passes no job tools, and bash runs to the
  end before the turn goes on. A pause ends the leg, and jobs do not
  survive that. Fixing them is its own piece of work.
- **Moving a session to another machine.** Tools a session learned are
  found by their files in the agent home, and MCP servers by the
  process's config. Both are there for two programs on one machine.
- **Switching the brain mid-session.** Neither program does it today.
- **A session's reply style.** A session started in the terminal keeps
  the terminal's style line on its thread when Perry continues it.

## Order of work

Each step leaves both programs working, and each is its own plan.

1. **The core.** Untangle the imports, add the core and the session
   program, export it. Tested under the scripted model with four kinds of
   answer: `message`, `model`, `options`, `budget`.
   (`docs/superpowers/plans/2026-11-18-shared-session-core-1-core.md`)
2. **Perry on the core.** Perry already has a driver, so this is the
   cheap way to give the core a real user.
   (`docs/superpowers/plans/2026-11-19-shared-session-core-2-perry.md`)
3. **The terminal on the core,** with the remaining commands as answers
   first, so no command is unavailable in between: the shell run, the
   driver, approvals out of the run, the session file format, saving at
   every pause. This is the first real handoff.
   (`docs/superpowers/plans/2026-11-19-shared-session-core-3-terminal-draft.md`,
   a draft)

## Decided

- **The effect is `agent::sessionInput`.**
- **Answers are one typed union,** checked where they arrive.
- **The turn budget is core state,** with no limit by default.
- **The program is exported. It does not move to the stdlib.**

## Open question

**Should a session's policy flags follow it?** The core could report
them in the pause's data, and the next front-end could apply them.
To be settled in the terminal's plan.
