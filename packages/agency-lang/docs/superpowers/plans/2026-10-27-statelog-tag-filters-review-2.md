# Review: StateLog tag filters plan (reuse, cost, security)

Plan: `docs/superpowers/plans/2026-10-27-statelog-tag-filters.md` at `84d7fa02d`.
Spec: `docs/superpowers/specs/2026-10-27-statelog-tag-filters-design.md`.
Prior reviews on this branch: `2026-10-27-statelog-tag-filters-review.md` (the earlier five-problem review) and `2026-10-27-statelog-tag-filters-existing-capabilities-review.md`.

The questions asked were: does this plan reuse what exists instead of rebuilding it, how much work is it, how much complexity does it add, and is it secure. Short answers first, then the evidence.

## Short answers

**Reuse.** Much better than the earlier `tagValues` plan. Every "already exists" claim I checked holds up. It reuses `runMetadata.custom`, `TraceFilter` plus `applyFilters`, the picker's unused `extraFilters` slot, `TableComponent`, `DetailScreen`, and the view-action tables. It adds no new storage field, no new config schema, no new filter engine, and no new table or layout code. The one new storage-ish thing is a single marker field, `customSource`, on an existing event. There is still one reuse miss, described below: the plan never considers that the picker's existing `/` search already finds agent runs, and that the runs explorer already shows and groups by agent name.

**Work.** Roughly 800 to 1,200 lines of production code and 1,500 or more lines of tests across five commits. The agency-js fixture in Task 2 (interrupt, resume, real subprocess, redaction, file parsing) is the fiddliest piece. I would budget two to four days of agent time including review rounds. The branch also needs rebasing: it forks from `b77f92377`, before the tool-output PR (#1289), so its diff against main currently shows unrelated deletions.

**Complexity.** Medium, and it is front-loaded in the parts you asked for least. About a third of the work is a thin setter plus a 30-line reducer. The other two thirds is UI: a new overlay view, a widened detail-screen target, two new keybindings, session-owned filter state, and shell wiring. That UI code is where the lifecycle bugs cluster (stale targets, header focus, follow refresh, draft isolation), and the plan's own test list shows it knows this.

**Security.** No hole that I can see. The setter writes only to the log, like `setAgentName`, and needs no interrupt. The viewer already escapes untrusted text. The plan handles `__proto__` and own-property reads correctly. One item in Task 1 touches the redaction chokepoint and I recommend dropping it, not because it is unsafe but because it adds a special case to a security-relevant path for almost no benefit.

**Recommendation.** Do not build the whole plan as a nice-to-have. Build a small first slice that gets most of the value, and leave the rest until there is a user for it. The slice is spelled out at the end.

## Reuse: what I verified

| Plan claim | Code | Holds? |
| --- | --- | --- |
| `custom: Record<string,string>` already flows from config to the log | `lib/config/config.ts:560` (zod schema), `lib/statelogClient.ts:72-77` (type), `:1110-1142` (writer and `agentStart` re-emit) | Yes |
| Picker has an unused `extraFilters: TraceFilter[]` and runs it through `applyFilters` | `lib/logsViewer/screens/tracePicker.ts:55`, `:180-186`; no other file sets it | Yes |
| `TraceFilter` is a predicate over `TraceSummary`, AND-composed | `lib/logsViewer/traceSearch.ts:11-15`, `:58-60` | Yes |
| Table owns widths, clipping, painting; width is number, `"flex"`, or `{ min }` | `lib/tui/table.ts:27` | Yes, and there is no `max`, so the plan's "bounded Agent column" must be a fixed width or computed in the picker, as the prior review said |
| `DetailScreen` takes a `rowId` and resolves it on every `setData` | `lib/logsViewer/views/detailScreen.ts:39-45`, `:121-122` | Yes |
| `runMetadata` is spread after `type`, so a caller can clobber the discriminator | `lib/statelogClient.ts:1115-1118` | Yes; the plan's reorder fixes it |
| Name rule is last valid `agentName` event | `lib/eval/extract.ts:126-131`, `lib/runsExplorer/mine.ts:168` | Yes |
| Redaction is a replacer over `data` only, in `post()` | `lib/statelogClient.ts:1670-1690`, `lib/runtime/redactForStatelog.ts` | Yes |
| Subprocess inherits parent `metadata` unless child sets `logFile` or parent has observability off | `lib/runtime/ipc.ts:1396-1420` | Yes |
| `agentStart` runs on every resume, so configured `custom` is re-emitted mid-trace | `lib/statelogClient.ts:1139-1141`; resume callers per the prior review | Yes. This single fact is why `customSource` and the two-dictionary reducer exist |

The plan does not duplicate the typechecker, the table, the search, or the filter engine. The existing-capabilities review did its job.

## The reuse miss: the goal is partly met today

The stated outcome is "find Agency-agent runs in a JSONL file containing many traces." Two things already do most of that, and neither the spec nor the plan mentions them as a baseline:

1. **The picker's `/` search already matches agent names.** `traceTexts` collects every string in every event's data (`traceSearch.ts:36-43`), and `agentName` events carry the name as a string. Typing `/coordinator` in the picker today lists exactly the traces that set that name, plus any trace whose prompt mentions the word. The Agency agent calls `setAgentName` (`lib/agents/agency-agent/agent.agency:117`), so historical logs already have this.

2. **The runs explorer already has an Agent column and group-by-agent.** `lib/runsExplorer/views/runsTableView.ts:68` binds `b` to "group by agent/suite", and `o` opens a run's log. The only reason it does not help here is routing: one statelog file always goes to the single-file viewer (`lib/runsExplorer/sources.ts:16-19`, `lib/cli/logsView.ts:101`).

So the honest gap is small: the picker shows no Agent column, and search is approximate rather than exact. Everything beyond that (a setter, a precedence model, a filter overlay, a metadata detail target) serves key/value tags, which no program writes today. `grep -rn runMetadata lib` finds no caller outside the client itself, and the sample log at `log.oct26.jsonl` has zero `runMetadata` events (per the prior review). The feature's key/value half has no existing user.

## Cost by task

| Task | Production code | Tests | Notes |
| --- | --- | --- | --- |
| 1. `runMetadata.ts` reader, writer marker, redaction restore | ~150 lines | ~250 | Reducer is simple. The redaction restore in `post()` is the one piece I would cut (below). |
| 2. `setTags` setter plus agency-js fixture | ~40 lines | ~300 | The fixture (interrupt, resume, subprocess, inherited sink, redaction, parse with production reader) is the single most expensive test in the plan. It is testing existing resume and IPC behaviour as much as the new setter. |
| 3. Columns, `DetailScreen` target union, `I` key, header focus | ~250 lines | ~300 | Touches `run.ts` (1,152 lines) and `detailTarget.ts`. Every existing `DetailScreen` call site changes. |
| 4. `traceFilters.ts`, `traceFiltersView.ts`, `F` key, session state | ~300 lines | ~400 | A new overlay view. `occurrencesView.ts` (298 lines) is the nearest existing pattern. |
| 5. Docs and final checks | ~100 lines of docs | | |

Total: roughly 750 to 1,100 lines of code and around 1,250 lines of tests, before review rounds.

## Complexity added to the codebase

Permanent additions, in order of how much they would be felt later:

1. **A second meaning for `runMetadata` events.** Today one event type, one meaning. After this, the same event means "configured defaults" or "an explicit update" depending on a marker, and readers that ignore the marker (the hosted viewer, `eval extract`, the runs explorer) will show the wrong value after a resume. That is a semantic the whole system now has to know about, and only one reader will.
2. **A new overlay view with its own draft state.** `traceFiltersView.ts` plus `applyMetadataSelection` on the session plus two new `ViewAction` kinds plus three new `TracePickerOptions` fields. This is the same shape as `occurrencesView`, so it is not foreign, but it is a new screen to maintain.
3. **`DetailTarget` as a union.** Every detail caller switches from a string to a tagged record. Small, but it ripples through `run.ts`, the header, and session focus.
4. **A `customSource` restore step inside `post()`.** A special case in the one function every log event passes through.
5. **A new stdlib function named `setTags`** alongside `std::tag.setTags`. Different modules, so no collision, but two tools with the same name and different meanings in the model's tool list is a real source of confusion for the agent. Consider `setRunTags` as the public name.

Items 1 and 4 exist only because `agentStart` re-emits configured metadata on every resume. A one-line alternative would be to stop that: emit configured metadata once at the first `agentStart` of a trace, not on resume. I did not verify what else depends on the re-emit (the hosted server may rely on it), so I am flagging it as a question, not a recommendation.

## Security

What I checked, and the verdict for each:

- **Can a model call `setTags` and do harm?** It writes a string dictionary to the log. Same trust level as `setAgentName`, which also has no interrupt. Fine.
- **Log injection into the TUI.** Tag values and names are untrusted text drawn on screen. The repo already has `lib/tui/untrusted.ts` for exactly this, and the plan says to use existing safe painting and tests ANSI and style-tag input. Fine, as long as the executor actually routes the new cells through `stripControlCharacters`. Worth a line in Task 3's checklist naming that function.
- **Prototype pollution.** The validator rejects `__proto__` and arrays, and the reader uses own-property reads keyed by trace ID and tag key. Config merge already strips `__proto__` (`lib/config/merge.ts:19`). Fine.
- **Discriminator clobbering.** Today `runMetadata({ type: "agentEnd" })` from JS would emit a mislabelled event. The plan puts `type` and `customSource` after the spread. Good, and this is a small hardening regardless of the feature.
- **The redaction restore.** Task 1 says: after redaction, put `type` and `customSource` back if the original was a `runMetadata` event with a recognised source. The threat it guards against is a user who calls `redact("defaults")` or `redact("explicit")` and thereby promotes or demotes tag updates. That is a data-quality problem for that one user, not a security hole, and the same thing already happens today if someone redacts the string `"agentStart"`. The restore writes constants only, so it cannot leak a secret. I still recommend dropping it: it is a special case in the chokepoint that protects two literals and nothing else, and the reader already treats an unrecognised marker as "no update". Fewer lines in `post()` is worth more than this guarantee.
- **Checkpoints and handlers.** The plan adds no runtime state and no checkpoint fields. Resume does not replay the setter. Nothing here can skip a handler. Fine.
- **Hosted server.** The plan sends an extra field on an existing event to a server outside this repo and says hosted behaviour is unverified. That is honest. If the server rejects unknown fields the setter silently loses its events; if it accepts them its viewer will show the pre-resume value. Neither is a security problem.

## Smaller plan defects

- **The plan is written in a dense, checklist-only style.** It has no Background section explaining how metadata flows today, and it relies on the reader having the spec and two prior reviews open. An executor who starts cold will not understand why `customSource` exists from the plan alone. One paragraph at the top would fix this.
- **Task 2's fixture asserts "preserved handler behavior"** without saying which handler or what preserved means. Spell out the one assertion.
- **The `I` and `F` bindings.** `F` already cycles the quick filter on the trace screen (`traceScreen.ts:207`). The plan keeps both and tests that neither breaks the other. That is acceptable, but a user will meet one key with two meanings one screen apart.
- **Format-check command.** Task 5 runs `pnpm run fmt:ts:check`, which globs every `.ts` under the package. In a nested worktree that glob reaches sibling worktrees. Run Prettier on named files instead, as the plan already says for the per-task steps.
- **Branch base.** Rebase onto current main before Task 1, or Task 3's `run.ts` edits will conflict with #1289.

## What I would build instead

A first slice that answers the stated need with almost no new surface:

1. **Agent column in the picker.** Add `agentName?: string` to `TraceSummary`, computed by the existing last-valid-`agentName` rule during `traceSummaries` (one `walkNodes` filter, same as `extract.ts:126-131`). Add a fixed-width column, dropped before `context` at narrow widths. Omit the column when no trace has a name. This is roughly 40 lines plus a render test, and it makes `agency-agent/coordinator` visible in every existing log without any new events.
2. **Exact-name filter through `extraFilters`.** A single `TraceFilter` with `id: "agent"` built from a name. The cheapest control is not an overlay: pressing `Enter`-equivalent on the Agent column, or a `/agent:coordinator` query prefix parsed in `shown()`, both fit in under 30 lines and need no new view, no session state, and no draft logic. The prefix form is the smaller of the two and composes with text search for free.

That slice is one commit, perhaps 100 lines of code and 150 of tests, and it reuses everything. It delivers the "find my agent runs" outcome.

Defer the rest until a program actually wants key/value tags:

- `setTags` and the `customSource` reducer: build when a real caller appears. When it does, revisit whether `agentStart` should re-emit metadata on resume at all, because removing that re-emit removes the need for the marker.
- The metadata detail target and `I`: the `runMetadata` event already appears in the trace screen, and its summary can include `custom` with a one-line change to `summary.ts:98`. That covers "see the full tags" without touching `DetailScreen`.
- The filter overlay and `F`: only worth it once there are enough distinct tag keys that a query prefix becomes clumsy.

If you do decide to build the full plan, the five tasks are in the right order and the reuse is sound. Cut the `post()` restore, rename the public setter to avoid a second `setTags`, and add the Background paragraph.
