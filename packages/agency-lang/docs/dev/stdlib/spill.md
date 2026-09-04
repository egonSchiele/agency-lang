# `std::spill`: where long tool output goes

`safeBash` used to cut a command's output at 2000 characters. That hid whether a build had finished, and the model re-ran the build through bash to find out. Now output past the cap is saved to a file and the model gets a preview: the exit code, a few lines from each end, and the file's name. `stdlib/spill.agency` owns the saving and the reading back; `lib/stdlib/spill.ts` does the file work.

## Decisions

**One fixed directory, outside every project.** Files go to `~/.agency-agent/tool-output` (or `AGENCY_TOOL_OUTPUT_DIR`, which exists so a test can point the spill at a directory it may delete). The first version put them under the command's working directory, which the model chooses through the `cwd` parameter of `safeBash`. That made an effect-free path, a long `echo`, write a file at a model-chosen location. It also did not work. The built-in read scope skips dot directories on purpose, so the "read it with `read`, no approval needed" promise in the notice was false, and a repository whose `.gitignore` has a `.*` rule hid the files from `grep` as well. A fixed home-directory path removes the model from the decision, keeps files out of `git status`, and gives one place to clean up.

**Two effects, two tools.** Saving raises `std::spill::write` and reading raises `std::spill::read`. Both carry only the file name. The recommended policy approves both outright, which it can do because neither effect carries a path the model picked: the write goes to the fixed directory, and `readSpill` and `grepSpill` accept a file name only, checked against the shape `_spillName` produces (`<timestamp>-<hex>.log`). A slash, a `..`, or a leading dot is refused before any interrupt is raised. This is why the notice can say "neither needs approval" without opening `std::read` or `std::grep` any wider.

**A rejected save falls back to truncation.** `keepOutput` chooses the file name first so the interrupt can say which file, then raises. If the save is rejected or the write fails, the output is cut at the cap with a `[truncated]` marker, which is what it always was.

**The preview is bounded by characters.** `previewHead` and `previewTail` each stop after `PREVIEW_CHARS`, and a single line is cut at `PREVIEW_LINE_LEN`. An earlier version showed fifteen lines from each end, which for 200-character lines made a preview three times longer than the output it replaced. The tail never reaches back into lines the head showed, so a two-line output is not printed twice.

## Where the pieces are

- `stdlib/spill.agency`: the effects, `keepOutput`, `readSpill`, `grepSpill`, and the notice text.
- `lib/stdlib/spill.ts`: `_spillDir`, `_spillName`, `_spillOutput` (creates the file with `wx`, mode 600, never overwriting), `_readSpill` (delegates to `_read` for offset and limit), `_grepSpill` (reuses the grep line matcher from `shell.ts`).
- `stdlib/safeBash.agency` and `stdlib/safeBash/actions.agency` call `keepOutput` on every output path; `safeBash` lists `std::spill::write` in its `raises` clause.
- `stdlib/agents/lib/toolkits.agency`: `shellTools()` hands the agent `readSpill` and `grepSpill` next to `safeBash`.
- `lib/runtime/builtinPolicies.ts`: both effects in the recommended policy.
- `tests/agency/safeBash.agency`: `longOutputIsSavedToFile` and `spillToolsTakeNamesOnly`.

## Things that are easy to miss

- A test that calls `safeBash` on a command with long output now sees a second interrupt, the save. `exactlyOneQuestion` in the safeBash tests answers it in a handler so the harness still sees exactly the git question; a checkout with many untracked files makes `git status` long enough to trip this.
- A failing `runBash` sends stdout and stderr through `keepOutput` separately, so one failing build can produce two files. `cliOutcome` in `safeBash.agency` concatenates the streams first. Both shapes predate this module and were left alone.
