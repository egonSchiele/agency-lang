# Agency agent: features other agents have

This table compares `agency agent` with Claude Code, Codex, pi, opencode, and
hermes. Each row is a feature people use often in those agents that the agency
agent does not have. The comparison was made on 2026-11-05.

Abbreviations: CC = Claude Code, Cx = Codex, OC = opencode, He = hermes.
Effort, impact, and complexity are rough estimates: S, M, or L.

## Status

- **Built** means it is in an open pull request. The PR column says which
  one.
- **Declined** means you said no.
- **Not planned** means it does not fit this round of work. The last section
  says why.

## The table

| # | Feature | Who has it | Effort | Impact | Complexity | Status | PR |
|---|---|---|---|---|---|---|---|
| 1 | Compaction of the main conversation, `/compact`, context % in the footer | all five | M | L | M | Built, self-contained version | #1395 |
| 2 | Type while the agent works: steer the current turn or queue a follow-up | all five | M–L | L | M | Not planned | |
| 3 | Undo: rewind the conversation and restore files the agent changed | CC, OC, He; pi for conversation only | M | L | M | Not planned | |
| 4 | Plan mode: a read-only mode you toggle | CC, Cx, OC, He | S | M–L | S | Declined | |
| 5a | Ctrl+G opens `$EDITOR` to write the prompt | all five | S | M | S | Built | #1393 |
| 5b | Pasted text detected automatically, without `/paste` | all five | S–M | M | M | Not planned | |
| 5c | A real multi-line editor | all five | L | M | L | Not planned | |
| 6 | `@file` completion | all five | S–M | M | S | Built. Tab completes one path segment at a time; there is no fuzzy search | #1393 |
| 7 | `!cmd` runs a shell command and adds the output to the conversation | CC, Cx, pi, OC | S | M | S | Built. The command runs directly, with no approval prompt | #1393 |
| 8 | `AGENTS.md` from parent directories, and `/init` | all five | S | M | S | Built | #1391 |
| 9 | Clipboard image paste | all five | S for a `/image` command on macOS, M for a key on every platform | S–M | S | Built: `/image`, macOS only | #1393 |
| 10 | Fork a session | CC, Cx, pi, OC, He | S | M | S | Built as `/fork`. There is no `--fork` flag | #1398 |
| 11 | Hooks: run a command before or after a tool call | CC, Cx, pi, OC, He | M | M | M | Not planned | |
| 12 | Background shell commands and background subagents | CC, OC, He | L | M–L | L | Not planned | |
| 13 | Custom subagents defined in a markdown file | CC, Cx, OC | M | M | M | Not planned | |
| 14 | `/goal`: keep working until a judge model says the goal is met | Cx, OC, He | S–M | M | S | Declined | |
| 15 | Memory with no per-turn model call | He, CC | M | M–L | M | Not planned | |
| 16 | Search over past sessions | He | S–M | M | S | Built | #1398 |
| 17 | JSON event stream for one-shot mode, and an editor protocol | CC, Cx, pi, OC, He | S for JSON, L for the protocol | M | M | Not planned | |
| 18 | Scheduled and looping prompts from inside the agent | CC, OC, He | S–M | M | M | Not planned | |
| 19 | Subscription login in place of an API key | Cx, pi, OC, He | M–L | L for adoption | M | Not planned | |
| 20 | OS-level sandbox for shell commands | Cx, CC | L | L | L | Not planned | |
| 21 | Chat gateway: talk to the agent from Telegram, Slack, and so on | He, CC | L | High for the people who want it | L | Not planned | |
| 22 | Diagnostics from a language server after each edit | He, CC | M–L | M | M–L | Not planned | |

## The four pull requests

**#1391: project context.** Row 8.

- The agent reads `AGENTS.md` from the working directory and from each parent
  directory up to the repository root. Today it reads the working directory
  only.
- `/init` asks the agent to write an `AGENTS.md` for the project.

**#1393: input.** Rows 5a, 6, 7, and 9.

- Ctrl+G opens `$EDITOR`. The text you save becomes the prompt.
- Typing `@`, part of a path, and Tab completes the path, one segment at
  a time.
- `!cmd` runs the command directly and adds its output to the conversation.
- `/image` saves the clipboard image to a temporary file and attaches it. It
  works on macOS only.

**#1395: compaction.** Row 1.

- The footer shows how much of the model's context window is in use.
- `/compact` summarizes the older part of the conversation.
- The same thing runs on its own between turns when the conversation is near
  the limit.
- The code is in one agent module. It does not change the memory feature or
  the tool loop. It cannot help inside one very long turn.

**#1398: sessions.** Rows 10 and 16.

- `/fork` makes the running session a copy with a new id. The original
  stays saved. To branch from an older session, resume it and run `/fork`.
- A search tool lets the agent find text in your saved sessions.

## Why the other rows are not planned

- **Rows 2, 5b, 5c.** These change the REPL's key handling. The REPL is built
  on Node's `readline`, which edits one line, and a mistake there breaks the
  approval prompt. They are also hard to test without a real terminal.
- **Rows 3, 11, 12, 13.** Each needs design decisions from you.
- **Row 15.** It changes the memory feature.
- **Row 17.** The event names become a public contract, so you should choose
  them.
- **Row 18.** It needs a decision about which policy an unattended run uses.
- **Rows 19 to 22.** These are large.
