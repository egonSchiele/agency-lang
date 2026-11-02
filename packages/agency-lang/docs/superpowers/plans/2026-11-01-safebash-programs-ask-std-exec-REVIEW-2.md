# Review 2: Programs with no rule of their own ask `std::exec` (ADI-243)

Plan: `docs/superpowers/plans/2026-11-01-safebash-programs-ask-std-exec.md`, at f6a5f62b5.

## Verdict

Ready to execute. Every point from the first review is folded in, and the fold-in is correct, not just present. Nothing new blocks it. Two small notes below, neither needs a plan change before work starts.

## What I checked in the revision

- **`BUILTIN_VERBS` is complete.** I ran `bash -c 'compgen -b'` on this Mac's bash 3.2 and got 58 names. Every one is in the plan's list, plus `mapfile`, `readarray`, and `compopt` from bash 5. `echo` is in the list and is also owned by its arm in `effectsFor`, which runs first, so the entry is harmless and keeps the list equal to bash's own.
- **The new message breaks no pinned text.** The only "no rule for" strings pinned in `safeBash.test.json` and the agency-js fixture are for `xargs`, `tee`, and `rg`. `xargs` and `tee` keep that text (wrapper, pipe-fed). `rg` is one of the two rows the plan says change. No builtin has a pinned message.
- **The two-list split is right.** Builtins and programs fail for different reasons and the plan gives each its own sentence. Keeping "no rule for" on the programs list is what saves the fixture.
- **`payloadsNamed` follows an existing idiom.** `payloadValuesAreCorrect` (tests/agency/safeBash.agency:183) reads effects through an `any` local with a comment saying why, so the new helper is the same shape and the plan's instruction to leave `lsPayloads` and `globPayloads` alone keeps the diff to the ticket.
- **The dev doc sentence exists where the plan says.** `docs/dev/stdlib/safe-bash.md:265` names `stdinStage` as the only reader of the pipe flag. The plan changes that sentence to name `pipedProgram` too.
- **The three payload differences, the `cwd` paragraph, the bash-not-exec exception, and the package runners** are all in the right sections (Background, Task 3 Step 1 and Step 2, the spec's Part 6 note).

## Notes

- **Row 26, `cat one.txt | pnpm test`.** The plan expects the pipe message for `pnpm`. The flattened order is `cat` first, then `pnpm`, and `planFor` keeps the first failure as `detail`. `cat one.txt` succeeds (it raises `std::read`), so the first failure is indeed `pnpm`'s. The expectation holds. I mention it because a reader may wonder which command's message wins in a pipe where both could fail.
- **`kill`, `printf`, `pwd`, and `test` are programs too.** They sit in `BUILTIN_VERBS` because bash runs the builtin, not `/bin/kill`, so the builtin rule is the right one. One clause in the `BUILTIN_VERBS` comment saying "bash picks the builtin over the program of the same name" will stop someone moving them out later.
