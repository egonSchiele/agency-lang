---
description: Review an agent run's log by the rows the person pointed at, through agency logs session
argument-hint: [address]
---

Please review the log of an agency run with me. I point at rows in the `agency logs` viewer; you read them with the `agency logs session` commands instead of grepping `log.jsonl`. The commands print a row the way the viewer shows it to me: the address `<trace id>/<row id>`, a header line such as `Thread · reviewer · LLM call 4 of 9 · gpt-5 · 2.1s · $0.004`, and the payload. Add `--json` to get the same facts as fields plus the row's raw events.

If I gave an address with this command, start with step 1's `show` on it: $ARGUMENTS

1. **"This one", "here", "what I'm looking at".** Run `agency logs session get`. It prints the row under my cursor in the open viewer. If I named an address instead, run `agency logs session show <address>`.
2. **"My comments", "the ones I marked".** Run `agency logs session comments`. It prints every comment on the trace I have open, each under its row. Answer each one with `agency logs session comment add <address> "<answer>" --reply-to <comment id>`, so the answer sits on the row in my viewer. A comment listed as `re-anchored` is on a row whose id no longer resolves; use its anchor (thread, name, time) to find the row.
3. **Explaining a row I am not on.** Run `agency logs session navigate <address>` first, so my viewer shows what you are describing. `navigate <trace id>` opens another run on its first row, and `agency logs session pick` puts me on the list of runs. A note you leave with `comment add` and no `--reply-to` is hidden in my viewer until I press `C`; tell me when you leave one.
4. **Reading deeper.** Use `agency logs session show <address> --json` for the raw events of one row. Do not grep the log file.

With no viewer open, `show`, `comments`, and `comment add` still work on the files when you pass `--log <file or run directory>`; `get`, `navigate`, and `pick` need the viewer. A bare row id needs `--trace <id>`; an address needs nothing.
