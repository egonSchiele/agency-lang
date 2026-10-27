# Agent names and run tags in the logs viewer

## Purpose

Make Agency agent runs easy to find in a JSONL file containing many runs. Display the recorded agent name and key/value run tags, and filter runs by either or both. The existing `log.oct26.jsonl` contains 482 traces, including 64 named `agency-agent/coordinator`; name filtering must work on those existing events without rewriting the file.

## Agreed requirements

- Expose `setTags` from `std::statelog`, not `addRunTags`.
- Tags are key/value pairs.
- Show and filter agent names and tags in the logs viewer.
- Keep the run list dense. Do not add a metadata line beneath every run or expand Overview entries.
- This delivery is a plan. Do not implement the feature yet.

## API and scope

Proposed Agency usage:

```agency
import { setAgentName, setTags } from "std::statelog"

node main() {
  setAgentName("agency-agent/coordinator")
  setTags({ family: "agency-agent", project: "agency-lang", interactive: true })
  setTags({ project: "website" })
}
```

The final tags are `{ family: "agency-agent", project: "website", interactive: true }`. Supplied keys overwrite their previous values; omitted keys remain. This follows the existing value-tag `setTags` behavior. The new function returns nothing, like `setAgentName`, and records metadata through the current run's logger.

Implementation choices for this plan:

- Tag values are JSON scalars: strings, finite numbers, booleans, or null. Nested objects and arrays are rejected. This keeps equality and filter choices understandable. `true`, `"true"`, `1`, and `"1"` remain distinct.
- Null is a value, not deletion. Empty strings, false, and zero are preserved. An empty patch changes nothing. Removing tags is outside this change.
- Keys are nonempty strings. Own keys such as `__proto__` and `constructor` are valid data and must not change an object's prototype.
- Tags describe the entire trace. A subagent can add keys or replace a supplied key. A different trace remains independent. Filtering a run retains all of its child activity.
- Agent naming keeps its existing last-recorded-name behavior. Thread labels remain separate. The bundled Agency agent records `{ family: "agency-agent" }` next to its existing `setAgentName` call.
- Every metadata event is a patch in source-file order. This includes configured metadata emitted again at `agentStart`: a later configuration event can replace an earlier value for the same key. No new checkpoint or runtime tag store is introduced. Document and test this rule rather than promising programmatic overrides survive a later conflicting configuration event.

`std::tag` continues to tag values and provide redaction. No value-tag implementation is redirected to run tagging.

## Storage and compatibility

Reuse the existing `runMetadata` event. Preserve its historical `tags: string[]` field on the wire, and add an optional `tagValues` object for key/value pairs. This avoids changing an existing field's type for other log consumers.

`log.metadata.tags` accepts a key/value object as the preferred configuration and continues accepting a string array. The StateLog writer translates an object to `data.tagValues`; a legacy array remains `data.tags`. `setTags` emits a `runMetadata` event containing `tagValues` through the same writer. No tag fields are added to every tool or prompt event.

Readers interpret an old label `"interactive"` as `{ interactive: true }`. When an event has both fields, `tagValues` takes precedence for overlapping keys. Across events, later supplied values win. Invalid saved entries are ignored individually without discarding the rest of the trace; invalid API/configuration input is rejected before writing.

One pure metadata projection owns these rules and agent-name extraction. The viewer computes it before grouping events into spans, because tree traversal and timestamps do not preserve file order. The existing eval extractor and streaming run scanner reuse the name rule without adding new public eval fields or an unused tags cache.

File and stdout output use the same normal StateLog serialization and redaction. The new field is additive within format version 1. This plan covers the local viewer, including a locally downloaded log. It does not claim that an older hosted viewer understands the new field or that concurrent live HTTP arrival reconstructs local file order.

## Dense display

The changed list is the **trace picker**, opened by `agency logs <file.jsonl>` and by `t` within a log with multiple traces. Overview is screen 1 for one trace; its model-call charts and preview layout stay unchanged.

The trace picker adds an Agent column and, where space permits, a compact Tags column. Every run still occupies one primary line. Existing annotation/comment lines retain their current behavior; this change adds none. Tag values are quoted when strings, such as `project="agency-lang"`, to distinguish them from booleans and numbers.

Column layout is declared as data. Keep Started, Agent, Duration, Cost, and the prompt visible; reserve at least 24 cells for the prompt at the supported minimum width of 100 columns. Drop optional columns in this order when needed: Tags, Context, LLM calls. When no trace has an agent name, omit the empty Agent column. Clip cells with the existing terminal-safe table renderer and never wrap a cell.

Show the selected agent name in the existing shared header. Uppercase `I` opens a scrollable metadata overlay with the full agent name, trace ID, and all tag pairs. It works for the selected picker row or the open trace, including a single-trace log. It does not add permanent rows to any screen.

Illustrative wide-terminal list:

```text
Agent: agency-agent/coordinator  Tags: project="agency-lang"    8 of 482
Started (local)        Agent                      Duration  Cost   Tags                  What
Oct 27, 10:24:15 AM    agency-agent/coordinator    7m25s     $0.24  project="agency-lang"  Compare benchmarks…
Oct 27, 11:08:02 AM    agency-agent/coordinator    2m10s     $0.08  project="agency-lang"  Review the result…

/ search   F filters   I metadata   Enter open   f follow
```

The example is a layout sketch, not a measurement of the sample file after filtering.

## Filtering and navigation

- `F` on the trace picker opens a filter overlay. Lowercase `f` keeps its existing follow behavior.
- The overlay offers observed agent names, tag keys, and typed values. Space selects choices; Enter applies the draft; Escape cancels it. A named Clear filters action clears the draft. No query-language parser is added.
- Multiple selected agents mean any selected name. Tag conditions combine with AND, with one selected value per key; choosing another value for that key replaces it. Metadata filters also combine with the existing text search using AND.
- A tag condition requires the key to exist and its value to match exactly. Missing differs from null. A name merely mentioned in a prompt does not match an agent-name filter.
- Filter choices come from all current trace metadata, not just the filtered rows. Keep active choices that temporarily have no matches so follow updates cannot silently remove a condition.
- Filter state belongs to the viewer session and survives opening a trace, returning to the list, and follow updates. The filter overlay edits a draft, not live session state.
- Keep the selected trace by ID when it still matches. Otherwise select the first matching row. An empty result has no actionable row; Enter does nothing and clearing filters remains available.
- On the picker, Escape cancels text editing/clears text search first, then clears metadata filters, then follows the existing back behavior. Inside an overlay, Escape closes that overlay first.
- `<` and `>` navigate matching traces and the position count uses the same matches. A trace already open stays open if a follow update makes it stop matching. Its header says `outside filters · N matches` instead of displaying an invalid position. From an excluded trace, `>` selects the first match and `<` selects the last; either key selects the sole match when there is one. With zero matches, navigation is a no-op.
- Opening a run with only metadata filters opens Overview. Only the existing payload text query is forwarded to the Trace screen.

Use the existing `TraceFilter`, `TableComponent`, `View`/overlay stack, declarative keybinding tables, and safe text painters. Keep matching and option derivation pure; view code owns focus and rendering.

## Boundaries and acceptance

No changes to compiler execution, handlers, interrupts, checkpoint formats, or the value-tag API. The separate multi-file Runs Explorer keeps its current controls; this plan adds filter controls to the JSONL trace picker and its embedded uses. No new dependencies.

Acceptance requires focused tests for typed patches, legacy logs, source ordering, redaction, dense row rendering, and filter/navigation lifecycle. Run a deterministic Agency-JS fixture for the public API, plus `make`, type checks, structure lint, and formatting. Save command output. Do not run the full Agency test suite or make paid model calls.
