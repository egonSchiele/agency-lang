# Review: StateLog tag filters plan

Plan: `docs/superpowers/plans/2026-10-27-statelog-tag-filters.md`
Spec: `docs/superpowers/specs/2026-10-27-statelog-tag-filters-design.md`
Reviewed against the worktree at `ff4d74458` (main `b77f92377` plus the plan commit).

## Summary

The plan matches the spec and most of its claims about the code hold up. I checked these against the source:

- The picker already has an unused `extraFilters: TraceFilter[]` slot (`lib/logsViewer/screens/tracePicker.ts:55`) and runs it through `applyFilters`. The metadata filters can plug straight into it.
- `makeActions.openPicker` (`lib/logsViewer/run.ts:528`) and `createHost` (`run.ts:605`) both build a fresh `TracePicker`, so session-owned filter state is needed.
- `ScreenHost.stepTrace` (`screenHost.ts:94-101`) returns early when there are fewer than two ids. It also uses `Math.max(0, indexOf(...))`, so from a trace that is not in the list, `>` jumps to the second match. The plan's fix is correct.
- `viewerHeader` (`run.ts:733-760`) reads the trace id from the picker only when the picker is the top overlay. A metadata or filter overlay opened over the picker would switch the header to the underlying screen's trace. The plan's "nested overlays keep their originating trace ID" item covers this.
- Follow mode rebuilds the whole forest (`run.ts:243`). Collecting metadata in `buildForest`'s first pass therefore needs no incremental logic.
- The sample log has 482 traces, and 64 of them are named `agency-agent/coordinator`. It has no `runMetadata` events.

Five problems need fixing before execution. Items 1 and 2 can produce wrong behavior. Item 3 breaks a standing rule from the owner.

## Problems to fix before execution

### 1. Every interrupt resume re-emits configured tags

The plan pins "configured, then setter, then configured again resolves to configured" as a source-order rule (Task 1). It does not say when the second configured emission happens. `agentStart` re-posts `this.metadata` (`lib/statelogClient.ts:1139-1141`), and `agentStart` runs on every resume (`lib/runtime/interrupts.ts:847` and `:993`), not only at the start of a run. A subprocess run inside the same trace also calls `agentStart` through `runNode` (`lib/runtime/node.ts:472`), and that call carries whatever metadata the child's config holds.

Example. `agency.json` sets `log.metadata.tags = { project: "configured" }`. The program calls `setTags({ project: "website" })` and then reads a file, which raises `std::read`. After the person approves, the trace's `project` is back to `"configured"`. This happens on almost any interactive run.

The spec chose this rule on purpose, so I am not asking to reopen it. The plan should do three things:

- Name resume and subprocess runs as the triggers in Task 1's test description and in the Task 5 docs, with the example above, so a user can predict it.
- Add a Task 2 fixture case that sets a configured tag, calls `setTags` on the same key, raises an interrupt, and resumes. Assert the final value. This checks the documented rule end to end, where the Task 1 unit test only checks the reducer.
- Check whether a subprocess child gets the parent's `log.metadata`. If it does, say so in the docs. If it does not, say that too.

### 2. The Agent column has no width cap, and `TableColumn` cannot express one

`TableColumn.width` accepts a number, `"flex"`, or `{ min }` (`lib/tui/table.ts:27`). There is no maximum. A column with no width uses the longest cell across all rows. `agentNameProblem` allows names up to 200 characters. One long name anywhere in the file would take over the row and squeeze the prompt below 24 cells.

Here is the arithmetic at 100 columns, using today's widths plus the one-cell gap each column already includes:

| Column | Cells |
| --- | --- |
| Started | 26 |
| Duration | 9 |
| Cost | 9 |
| Agent (`agency-agent/coordinator` plus gap) | 25 |
| Prompt (minimum) | 24 |
| **Total** | **93** |

That leaves 7 cells. `LLM calls` (10) and `context` (8) do not fit, and the `hits` column (5) that appears during a search does. The spec's drop order does not mention `hits`.

Fix in Task 3:

- Give Agent a fixed width or a capped natural width, and say which. Either add `{ min, max }` to `TableColumn` in `lib/tui/table.ts` with a test, or compute the width in the picker's column data.
- Put `hits` into the declared drop order. I suggest it never drops, because it is the reason a row is shown.
- Add a 100-column render test with a 200-character agent name and an active search.

### 3. Task 5 edits `docs/site/guide/`, which the owner has asked not to touch in feature PRs

Task 5 and the file table list `docs/site/guide/{observability,tags}.md`. The owner writes the user-facing guide. Feature PRs ship code, tests, and `docs/dev/**` only. Remove both guide pages from the plan.

The generated stdlib page (`docs/site/stdlib/statelog.md`) is fine, because `make` writes it from the `.agency` doc comments. If the guide becomes stale, mention it once in the PR description.

### 4. Uppercase `F` already means something on the Trace screen

`lib/logsViewer/screens/traceScreen.ts:207` binds `F` to "cycle errors, tools, interrupts and all rows". The plan binds `F` on the picker only, so the two do not collide in code. A user still meets one key with two meanings one screen apart. Task 4's lifecycle list checks that lowercase `f` keeps its meaning but does not mention the Trace screen's `F`.

Pick one of these:

- Keep `F` and add a Task 4 test that `F` on screen 2 still cycles the quick filter after the change. Add a note in `docs/dev/cli/logs-viewer.md` that `F` is per-screen.
- Choose a key with no existing binding.

The same check applies to `I`. Nothing binds it today. The plan says `I` works "for the selected picker trace or current open trace", so it is a shell binding, and it needs `when: () => !controls.typing`. Otherwise, typing `I` into the picker's `/` search opens the overlay. Add a test that types `"FIX"` into the search query and checks that the query reads `FIX` and that no overlay opened.

### 5. The plan quietly makes the text query persist across picker reopenings

`TracePickerState = { query: string; metadata: MetadataSelection }` puts the text query in session state. Today the query is lost when the picker is rebuilt. Pressing `t` or Escaping back from a trace opens a picker with an empty search. The spec asks for metadata filters to survive navigation. It does not ask for the text query to survive.

This might be the better behavior, but it is a change to existing behavior that the spec does not mention. Either drop `query` from the session state, or state the change in the spec and add it to the Task 4 lifecycle tests. The current tests ("Escape clearing text before metadata") assume the query is still there after a reopen.

## Smaller items

6. **Say that `agentName` comes from its own event.** `setAgentName` writes an `agentName` event (`lib/statelogClient.ts:1046`), separate from `runMetadata`. Task 1's interface reads as if `applyTraceMetadata` only handles `runMetadata` data. Add a Task 1 test: an `agentName` event sets the name, a later one replaces it, and a non-string name is ignored, matching `lib/eval/extract.ts:131` and `lib/runsExplorer/mine.ts:168`.

7. **Run `pnpm run typecheck` at the end of every task.** Vitest strips types and does not report type errors. The plan runs typecheck only in Task 5. Tasks 1, 3, and 4 change shared types (`RunMetadata`, `TreeNode`, `TraceSummary`, the `ViewAction`/overlay names), so a type error would sit unseen through three commits. Add the typecheck to each task's verification step, before its commit.

8. **Format named files only.** `pnpm run fmt:ts` formats the whole package. Run Prettier on the files the task changed, and keep `fmt:ts:check` as the gate.

9. **Rename the TypeScript helper to `_setRunTags`.** The plan keeps `_setTags` in `lib/stdlib/statelog.ts` and notes that `lib/stdlib/tag.ts` has its own `_setTags(value, tags)`. They do not collide, but two helpers with the same name and different signatures make grep results and stack traces confusing. The public Agency name stays `setTags`, as the spec requires.

10. **Add a docstring line about the two `setTags` functions.** `std::tag.setTags(value, tags)` and `std::statelog.setTags(tags)` will both exist. A program importing both needs `import { setTags as setRunTags } from "std::statelog"`. Docstrings become tool descriptions, so the new one should say which tags it sets ("tags on this run's trace, shown in the logs viewer") and point to `std::tag` for value tags.

11. **Test the config path in the Agency-JS fixture.** The fixture's `agency.json` could set `log.metadata.tags` to an object. Then one compiled run covers config to `tagValues` encoding, the `agentStart` emission, and the setter patches together. Today that path is covered only by the unit tests.

12. **Give the sample log's absolute path.** Task 5 says to use "the real local sample files read-only". The file is untracked in the main checkout at `/Users/adityabhargava/agency-lang/packages/agency-lang/log.oct26.jsonl` and does not exist in the worktree. Name that path so the executor does not copy it in.

13. **Redacting a primitive matches by value.** `std::tag` keys primitives by value (`lib/stdlib/tag.ts:15`). `redact("agency-lang")` anywhere in the run therefore scrubs a `project: "agency-lang"` tag, and `redact(true)` scrubs every boolean `true` tag. This is existing redaction behavior, and the plan's redaction tests are fine. Add one sentence about it to `docs/dev/hosting/statelog.md`.

14. **Do not show a redacted tag value as an ordinary filter choice.** A redacted scalar arrives as the replacer's placeholder string, and the filter overlay will list it like any other value. Decide whether that is wanted. If it is not, add a test.

15. **Plan review checklist.** The last box ("Only this design and plan are written during the current planning task") belongs to the planning session, not to the executor. Remove it, or the executor will read it as a step.

## Things I checked that are fine

- Collecting metadata in pass 1a of `buildForest` gives file order across interleaved spans. `HIDDEN_EVENT_TYPES` holds only `graph`, so `runMetadata` is never skipped.
- `extract.ts` and `mine.ts` can share the name rule without changing their output shapes.
- The per-invocation config path (`lib/runtime/invocationOptions.ts:71,175`) takes its type from `AgencyConfig`, so widening the config type also widens it. Task 1 should include `invocationOptions` in the typecheck that item 7 adds.
- `std::statelog` is not in the prelude, so the new `setTags` does not shadow `std::tag.setTags` in programs that never import it.
