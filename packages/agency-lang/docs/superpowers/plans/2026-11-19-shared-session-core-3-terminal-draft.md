# Shared Session Core, Plan 3: The Terminal on the Core (draft)

**This is a draft.** It fixes the decisions and the order of work. It is not yet a plan to execute: the steps have no tests and no exact signatures, because five facts it depends on are not known yet ("To find out first"). Tighten it after Plan 2 lands, since Plan 2 changes the core this builds on.

**Goal:** `agency agent` runs its sessions through the session core, so a session started in the terminal can be continued in Perry and the other way round. The terminal keeps every command it has today.

**Spec:** `docs/superpowers/specs/2026-11-18-shared-session-core-design.md`. The core as built: `docs/dev/agents/session-core.md`.

## The shape

`agency agent` becomes two runs in one process.

- **The shell run** is `agent.agency`. It parses the flags, picks the session, and calls `repl()`. It is never saved. The pickers and the approval prompt run here, in Agency.
- **The session run** is `program.agency`. A TypeScript driver starts or resumes it.
- **The driver** is new TypeScript. For each line the REPL submits, it sends an answer to the session run, prints the events, and when the run pauses on an approval it calls the shell's prompt and resumes with the result. It saves the session at every pause.

A check on a real terminal (2026-11-19, in the spec under "What we know works") showed that `repl()`, the pinned approval prompt, Esc and Ctrl+D all work in this shape with no change to `lib/stdlib/cli.ts`. The footer was not checked.

## Decisions

- **This plan absorbs what was Plan 4.** The remaining commands become answers before the terminal switches over, so no command is unavailable in between. There is no fourth plan.
- **One switch, no flag.** The old loop (`runSession`, `_sessionOnSubmit`, the in-run `restore`) is deleted in the same pull request that adds the driver. Nobody else uses the agent, so a second path would only be something to keep working.
- **Sessions saved before the switch cannot be resumed after it.**
- **The session file is Perry's `SavedRun`,** moved into agency-lang with its checks, so both programs read and write it with the same functions.
- **One-shot runs (`-p`) go through the core too.** The driver sends one message and declines what no rule decides. That leaves one path for approvals.
- **Background jobs are removed from the agent,** with `/jobs`. A job stops when the run pauses, and the session run pauses after every turn. Bash runs to the end before the turn goes on.
- **Policy flags follow the session.** `--policy`, `--approve` and `--reject` are kept in the session's start data and reported at the pause, so a front-end that resumes the session applies the same policy. Today they survive a resume because they are globals. Without this, a session started under `--policy minimal` would run under the looser shared policy once Perry resumed it.

## To find out first

Each of these changes a task below. Find them out before writing the steps.

1. **Do top-level `callback(...)` blocks fire for a run that another run's TypeScript started?** `trace.agency` prints tool calls from them, in the shell's modules. The session run loads `program.agency`, which must not load `trace.agency`. So the driver most likely has to pass the callbacks itself, and `trace.agency`'s printing has to be callable from TypeScript.
2. **What does the footer need?** `printFooter` reads token counts from the run `repl()` is in, which is the shell's. It has to read the session run's. Find the smallest change to `cli.ts`: probably the driver summing `onLLMCallEnd` and the REPL taking the counts from a function it is given.
3. **How much of `cliPolicyHandler` is the prompt, and how much is the policy?** The run's own policy now answers what a rule decides. The terminal needs the other half: draw the prompt for one interrupt, and save an "always" answer to the policy file. Perry's engine does this in TypeScript with `promptOptions` and `resolvePromptOption`. Decide whether the terminal uses those too, or keeps the Agency code in `std::policy` behind a new exported function.
4. **Several approvals in one pause.** A turn with parallel tool calls pauses on more than one interrupt. `cliPolicyHandler` has tests for this case (`tests/agency-js/cli-policy-handler-parallel*`). The driver needs the same behaviour, in particular that a rule saved by the first answer settles the ones still waiting.
5. **Each process's own setup.** The shell does MCP configuration before it resumes a session. Check memory, local-model setup and anything else `main` does today that is not run state.

## The work, in order

1. **The remaining answers in the core:** `compact`, `rename`, `fork`, `search`, `reload`, and `local` if a local model can be switched to mid-session without ending the process. Each is an arm that calls the function its slash command calls today, with its lines as notices. `rename` and `fork` return terminal wording now ("Usage: /rename <title>", "reopen it with: agency agent --resume <id>"): the core returns the fact, and each front-end words it.
2. **The session file format** in `lib/stdlib/agentSessions.ts`: `SavedRun`, its check, save and read. The record comes from the pause's data.
3. **The driver:** start, resume, one answer and its events, approvals, save at each pause, abort on Esc, and the one-shot mode.
4. **The shell:** `agent.agency` builds a `ProgramStart` from the flags and hands the REPL the driver's submit function. `--continue` and `--resume` read a `SavedRun` and resume it, in place of the in-run `restore`. The transcript shown on resume is read from the pause's checkpoint, as now.
5. **The slash commands:** each one that changes the session sends its answer. Each picker reads what it lists from the pause's data. `!` shell commands run in the shell, in the folder the pause reports, and their output goes with the next message as a note.
6. **Delete the old loop:** `runSession.agency`, `_sessionOnSubmit` and `_installSessionHooks`, `saveSeedTurn`, the in-run `restore` in `resume.agency`, the job tools and `/jobs`. The `setInteractive` switch for the reply style and the job tools goes with them.
7. **The handoff, by hand and in a test:** a session started with `agency agent` is continued by a second process through `agency-lang/agent-session` and then continued again in the terminal. With Perry on the core, the same thing between the terminal and the Mac app.
8. **Docs:** `agent-brains.md`, `agent-sessions.md`, `session-core.md`, and the user guide's pages on the agent, for what changed.

## What is most likely to go wrong

- **The first turn after a resume in a fresh process.** The terminal has never resumed in the middle of a turn. #1506 was found this way, and there may be more.
- **Output order.** Today a notice prints when the code reaches it. With events, the driver prints them as they arrive, and the REPL's spinner and footer are drawn around the turn. Check the order of an attachment line, a tool trace and the reply against today's.
- **Esc during an approval.** The prompt is in the shell's run and the turn is in the session's. Esc must drop the turn, as it does now.
- **The size of a saved session.** The agent saves a checkpoint taken between turns today. A pause in the middle of a turn holds every frame of the turn, and it is written at every approval.
