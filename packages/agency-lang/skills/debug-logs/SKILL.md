---
name: debug-logs
description: Read an Agency run's log through the agency logs commands instead of grepping log.jsonl. Use when asked to look at the logs, what happened in the last run, or why a run failed, and when the person points at rows or comments in the agency logs viewer.
---

Read Agency logs with the `agency logs` commands. Never grep or `cat` the log file: one LLM call's line can be hundreds of kilobytes, because every call stores the whole conversation so far.

Every command prints rows by their address, `<trace id>/<row id>`, and a header line such as `Thread · reviewer · LLM call 4 of 9 · gpt-5 · 2.1s · $0.004`. Add `--json` to any command for the same facts as fields.

No command needs `--log` when a viewer is open or `agency.json` names the log (`log.logFile`). Otherwise pass `--log <file or run directory>` to each one. The first line of every command's output names the file it read.

## A run you look at on your own

1. **Find the run.** Run `agency logs traces --last 5`. Each line has the trace id, when it started, its cost, its LLM calls, and its first user message. Pick the run by its message and time. Skip this step when you were given a trace id.
2. **Read the outline.** Run `agency logs outline --trace <id>`. It prints every row of the run with its address. For a run of a few hundred rows this is the whole story, so read it before you search. With no `--trace`, it reads the most recent run.
3. **Find rows.** Run `agency logs search <words> --trace <id>` when the outline is long, or when you are looking for an error, a file name, or a tool. Each hit is a row and its address. Narrow with `--kind error`, `--kind tool`, or `--kind user`. `--all` searches every run in the log.
4. **Read a row.** Run `agency logs session show <address>` on an address from the outline or a search. Add `--json` for the row's raw events.

## Rows the person points at in the viewer

1. **"This one", "here", "what I'm looking at".** Run `agency logs session get`. It prints the row under the person's cursor. If they gave you an address, run `agency logs session show <address>`.
2. **"My comments", "the ones I marked".** Run `agency logs session comments`. Answer each with `agency logs session comment add <address> "<answer>" --reply-to <comment id>`, so the answer sits on the row in their viewer. A comment listed as `re-anchored` is on a row whose id no longer resolves; use its anchor (thread, name, time) to find the row.
3. **Explaining a row they are not on.** Run `agency logs session navigate <address>` first, so their viewer shows what you describe. `navigate <trace id>` opens another run, and `agency logs session pick` puts them on the list of runs. A note you leave with `comment add` and no `--reply-to` is hidden in their viewer until they press `C`; tell them when you leave one.

`get`, `navigate`, and `pick` need the viewer. A bare row id needs `--trace <id>`; an address needs nothing.
