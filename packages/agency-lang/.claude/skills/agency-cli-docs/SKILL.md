---
name: agency-cli-docs
description: Developer docs for the Agency CLI and terminal UI: command line argument handling, the vendored commander fork, the agency doc cache, the sandbox flags for untrusted code, the interactive debugger, the logs viewer and cross-run explorer, and the TUI toolkit. Use when changing a CLI command or anything that draws in the terminal.
---

# Cli developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/cli/cli-arguments.md` — How one command line carries both agency's own flags and the program's.
- `docs/dev/cli/vendored-commander.md` — The vendored commander fork, what was changed in it, and the rules for keeping it in sync.
- `docs/dev/cli/doc-cache.md` — The incremental cache behind `agency doc`, and how it decides a page is stale.
- `docs/dev/cli/effects-command.md` — `agency effects`, which lists the capability sets and built-in policies the approval flags accept, and where its data comes from.
- `docs/dev/cli/test-cli-sandbox.md` — The flag combination that makes it safe to run Agency code you do not trust.
- `docs/dev/cli/debugger.md` — The interactive debugger: stepping, inspecting variables, and rewinding.
- `docs/dev/cli/debugger-tests.md` — Driving the debugger headlessly in tests.
- `docs/dev/cli/debugger-future-work.md` — The few debugger and TUI items still open.
- `docs/dev/cli/logs-viewer.md` — The interactive viewer for a single statelog trace, including the timeline.
- `docs/dev/cli/runs-explorer.md` — The cross-run table `agency logs` opens when pointed at several paths.
- `docs/dev/cli/tui.md` — The terminal UI toolkit the debugger, the viewer, and `std::ui` are built on.
- `docs/dev/cli/tui/guide/getting-started.md` — Writing a first TUI screen, and the builders available.
- `docs/dev/cli/tui/guide/terminal-usage.md` — Running a TUI against a real terminal: input, signals, and resizing.
- `docs/dev/cli/tui/guide/testing.md` — Testing a TUI with scripted input and recorded frames, no terminal needed.
- `docs/dev/cli/tui/dev/elements-and-builders.md` — The element tree and the builder functions that produce it.
- `docs/dev/cli/tui/dev/layout.md` — The flexbox-lite layout engine that assigns every element a position and size.
- `docs/dev/cli/tui/dev/rendering.md` — How a laid-out element tree becomes terminal output, HTML, or plain text.
- `docs/dev/cli/tui/dev/input-output.md` — The injected input and output interfaces that make the TUI testable.
- `docs/dev/cli/tui/dev/style-parser.md` — The inline `{bold}` style tag syntax, and the ANSI sequences the parser also understands.
