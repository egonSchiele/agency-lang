---
name: agency-cli-docs
description: Developer docs for the Agency CLI and terminal UI: command line argument handling, the vendored commander fork, the agency doc cache, the sandbox flags for untrusted code, the interactive debugger, the logs viewer and cross-run explorer, the `agency skills` command, and the TUI toolkit. Use when changing a CLI command or anything that draws in the terminal.
---

# Cli developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/cli/cli-arguments.md` — How one command line carries both agency's own flags and the program's.
- `docs/dev/cli/vendored-commander.md` — The vendored commander fork, what was changed in it, and the rules for keeping it in sync.
- `docs/dev/cli/doc-cache.md` — The incremental cache behind `agency doc`, and how it decides a page is stale.
- `docs/dev/cli/effects-command.md` — `agency effects`, which lists the effect sets and built-in policies the approval flags accept, and where its data comes from.
- `docs/dev/cli/test-cli-sandbox.md` — The flag combination that makes it safe to run Agency code you do not trust.
- `docs/dev/cli/debugger.md` — The interactive debugger: stepping, inspecting variables, and rewinding, including stops inside a tool call and between the tool loop's requests and calls.
- `docs/dev/cli/debugger-tests.md` — Driving the debugger headlessly in tests.
- `docs/dev/cli/debugger-session.md` — `agency debug session`, the debugger an agent drives one command at a time: the visit, the readers, the `where` summary, the target rules, the exit codes, and the one-visit-one-reply invariant.
- `docs/dev/cli/debugger-attach.md` — Attaching the debugger to a running program: the channel and its messages, `registerAttach` and the `SIGUSR2` trigger, the sessions directory and the check that is the safety argument, the socket, and the `agency debug --attach` command: the listing, the start-time check, the UI while attached, and the exit codes.
- `docs/dev/cli/debugger-future-work.md` — The few debugger and TUI items still open.
- `docs/dev/cli/logs-viewer.md` — The logs viewer: screens, the timeline kernel, follow mode, row IDs as a contract and addresses, the hosted tool calls a provider ran inside a model call, comments as marks with the one comments source, the session a CLI talks to over a socket, and the agent commands (`traces`, `outline`, `search`): `chooseLog` as the one place a log is found, search as a filter over transcript blocks, and `blockRowId` as the one block-to-row mapping.
- `docs/dev/cli/runs-explorer.md` — The cross-run table `agency logs` opens when pointed at several paths.
- `docs/dev/cli/skills-command.md` — `agency skills`: where the shipped skills live and how they reach the npm package, why `install` writes a stub that runs `agency skills show`, why the repo's own commands read the file instead, the marker prefix that keeps it from overwriting a hand-written skill, the all-or-nothing check, and the symlink refusal.
- `docs/dev/cli/tui.md` — The terminal UI toolkit the debugger, the logs viewer, `eval new`, `label`, and the runs explorer are built on.
- `docs/dev/cli/tui/guide/getting-started.md` — Writing a first TUI screen, and the builders available.
- `docs/dev/cli/tui/guide/terminal-usage.md` — Running a TUI against a real terminal: input, signals, and resizing.
- `docs/dev/cli/tui/guide/testing.md` — Testing a TUI with scripted input and recorded frames, no terminal needed.
- `docs/dev/cli/tui/dev/elements-and-builders.md` — The element tree and the builder functions that produce it.
- `docs/dev/cli/tui/dev/layout.md` — The flexbox-lite layout engine that assigns every element a position and size.
- `docs/dev/cli/tui/dev/rendering.md` — How a laid-out element tree becomes terminal output, HTML, or plain text.
- `docs/dev/cli/tui/dev/input-output.md` — The injected input and output interfaces that make the TUI testable.
- `docs/dev/cli/tui/dev/style-parser.md` — The inline `{bold}` style tag syntax, and the ANSI sequences the parser also understands.
- `docs/dev/cli/workflow-command.md` — `agency workflow`: the driver each command writes and runs, its fixed text with `DRIVER_NAMES` and `DRIVER_NODES`, which bad steps are left for `checkWorkflow` and which the command reports, why `with approve` is safe in the driver, why the driver is not sandboxed and why `distDir` is cleared, the temp folder with its synchronous cleanup, and `run`: the three parts of its policy and their order, the start rules and how each spells its data, why a person's `"*"` turns it all off, why there is no `-i`, and which flags reach the child.
