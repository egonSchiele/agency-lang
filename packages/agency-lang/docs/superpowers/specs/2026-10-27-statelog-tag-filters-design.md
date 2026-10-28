# Agent names and run tags in the logs viewer

**Status:** Revised design for the requested plan. This replaces the earlier `tagValues` proposal. Implementation has not started.

## Outcome and scope

Make Agency-agent runs easy to find in a JSONL file containing many traces. Show recorded agent names and string key/value run tags in the trace picker, and let users filter by either or both. Keep one primary row per trace. Overview's per-call layout stays unchanged.

The user requires `std::statelog.setTags`, reuse of existing `runMetadata.custom` and viewer components, and explicit setter values that override configured defaults after resume and subprocess starts.

The [existing-capabilities review](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/docs/superpowers/plans/2026-10-27-statelog-tag-filters-existing-capabilities-review.md) records the source inspection. Existing configuration, code generation, runtime forwarding, logging sinks, and transport already carry `custom: Record<string, string>`. The picker already has `TraceFilter`, AND composition, text search, declarative table columns, and an overlay stack.

String values, per-key patching, the historical-log rule, and the UI details below are design choices for this revision. Richer value types and deletion are outside this change.

## Public API and existing configuration

```agency
import { setAgentName, setTags } from "std::statelog"

node main() {
  setAgentName("agency-agent/coordinator")
  setTags({ family: "agency-agent", project: "agency-lang" })
  setTags({ project: "website" })
}
```

The final explicit tags are `family="agency-agent"` and `project="website"`. Supplied keys replace earlier explicit values. Omitted keys remain. Empty strings are values; an empty patch emits nothing. The setter returns nothing, like `setAgentName`.

With logging enabled, users can already configure defaults:

```json
{
  "observability": true,
  "log": {
    "logFile": "./runs.jsonl",
    "metadata": {
      "tags": ["interactive"],
      "custom": {
        "project": "configured",
        "environment": "development"
      }
    }
  }
}
```

Keep this configuration schema unchanged. `tags: string[]` remains a separate legacy label field. Do not convert labels to booleans or introduce `tagValues`.

Validate the setter as an ordinary string dictionary, accepting plain and null-prototype records and their own enumerable string entries. Reject arrays, null, non-string values, and the key `__proto__`. Permit empty keys and empty string values, as the existing custom configuration does. Preserve `constructor` and `prototype` as own data keys without prototype mutation. Invalid input fails atomically without echoing values. Validation returns the original object so whole-object redaction still works.

A valid call outside an Agency frame is a no-op, following `setAgentName`. Invalid input still fails there. Observability and sink settings retain their existing behavior.

`std::tag.setTags(value, tags)` continues to tag individual values. Programs importing both functions can alias the run setter as `setRunTags`. No changes to the value-tag system are needed.

## Event contract and precedence

Store all run-tag values in the existing `data.custom` dictionary. Add one writer-owned discriminator outside that dictionary:

```json
{"type":"runMetadata","customSource":"defaults","custom":{"project":"configured"}}
{"type":"runMetadata","customSource":"explicit","custom":{"project":"website"}}
```

`customSource` is event context, not configurable user metadata. It says how to interpret `custom` only. Other metadata fields retain their current meaning.

Extend `StatelogClient.runMetadata(metadata, customSource = "defaults")`. Existing `agentStart` calls therefore emit `"defaults"`. The new stdlib setter passes `"explicit"`. Construct the event with reserved `type` and `customSource` after the supplied metadata so an extra top-level JavaScript property cannot replace them. Do not mutate the client's configured metadata.

The reader processes each trace's events in file order and keeps two private dictionaries:

- Defaults: later default events replace supplied default keys.
- Explicit values: later explicit events replace supplied explicit keys.

Effective tags are defaults overlaid with explicit values. Presence of an explicit key wins even when its value is the empty string. Neither class deletes omitted keys. A new explicit call can change an earlier explicit value. A default event can never overwrite an explicit key.

| Event sequence for one trace | Effective tags |
| --- | --- |
| Defaults `project="configured", environment="dev"` | `project="configured", environment="dev"` |
| Explicit `project="website"` | `project="website", environment="dev"` |
| Resume emits the same defaults | `project="website", environment="dev"` |
| Subprocess emits defaults `project="child", region="west"` | `project="website", environment="dev", region="west"` |
| Subprocess explicitly sets `project="review"` | `project="review", environment="dev", region="west"` |

The synthetic child-default example tests precedence independently of inheritance. On the normal shared-sink path, subprocesses inherit the parent's configured metadata today. Keep that forwarding unchanged and test the real path as well.

### Historical and malformed events

Treat an absent `customSource` as `"defaults"`. Thus existing custom metadata remains visible and filterable, and later unmarked values replace earlier unmarked values per key. Historical events do not reveal whether a low-level caller intended a default or an explicit update. Do not infer it from `entryNode`.

An unknown, null, or otherwise invalid source marker contributes no custom update. Ignore a malformed custom dictionary, including a whole-dictionary redaction placeholder. Within a saved dictionary, ignore non-string entries and `__proto__` while retaining valid siblings. Ignore inherited properties. Preserve the prior valid state.

These rules apply only to custom-tag extraction. Separate `agentName` events keep their existing last-valid-string-in-file-order rule. This feature does not introduce a root-agent identity.

### Redaction and transport

Use the existing `post()` serialization and redaction path. Preserve the original custom dictionary until that path runs. Its values and the whole dictionary remain redactable.

Protect the fixed `runMetadata` discriminator and known `customSource` values from value redaction. After redaction, restore only these two reserved fields when the original body has `type="runMetadata"` and a recognized source. Never restore the original `custom` or spread the original body back over redacted data. This prevents a replacement such as `redact("defaults", "explicit")` from promoting configuration into explicit updates.

The event remains format version 1 with an additive field. File, stdout, and HTTP continue using the same serialized envelope. This plan guarantees the local reader's behavior, including a downloaded file in its supplied order. The hosted server and hosted viewer's merge semantics are not verified here.

## Runtime scope

The tags describe one trace across branches and subprocesses sharing that trace. A reader reconstructs precedence from the saved events. Resume does not need to replay completed setters.

Do not add tag state to the runtime, checkpoints, or IPC. Do not mutate configuration to remember setter calls. This keeps handler registration and restoration unchanged.

A separate trace is independent. Rewind into a new trace, or a file containing only the resumed segment, cannot recover annotations absent from that file. This delivery does not add annotation replay or copy earlier metadata into new traces.

## Dense display through existing components

The changed list is the trace picker shown for a mixed JSONL file. Add Agent and, when space permits, Tags columns to its existing `TableComponent`. Format tag cells as `key="value"`, with deterministic key ordering. Use existing safe text painting and clipping.

Keep Started, Agent, Duration, Cost, active-search Hits, and the prompt visible at the supported minimum of 100 columns. Cap Agent at 25 cells including its gap, and reserve at least 24 prompt content cells plus its gap. Existing fixed widths leave 26 prompt cells at 100 columns with Hits present. Drop optional columns in this order: Tags, Context, LLM calls. Omit Agent entirely when all traces lack a name. Add no metadata annotation rows.

Uppercase `I` opens full metadata for the selected picker trace or the open trace. Reuse `DetailScreen` with a typed trace-metadata target. Reuse its `PayloadLine` rendering, wrapping, scrolling, raw JSON, copying, and follow refresh. Show the trace ID, name, and effective tags. An event-detail target still behaves exactly as before.

A metadata detail target has a trace ID but no commentable row ID. Header, comment controls, and session focus must use that target's trace ID, including when it is opened over a picker selection different from the underlying trace. Keep the selected agent name in the existing header without adding a row.

Update the existing `runMetadata` event summary to include `custom`. Retain legacy label display.

## Filters through the existing predicate interface

Uppercase `F` on the picker opens a small filter overlay. Use the existing table, cursor bindings, declarative key tables, and view actions. Do not build a new query parser or filtering engine.

The overlay lists observed agent names and key/value pairs from all current trace summaries. Include selected choices even when they no longer occur. Space toggles a choice. Enter applies the draft; Escape cancels it. A Clear filters row empties the draft.

Multiple selected names combine with OR. Different selected tag keys combine with AND. At most one value is selected per key; choosing another replaces it. Names and tag values match exactly and case-sensitively. A tag predicate requires an own key. Metadata predicates compose with existing text search through `TraceFilter` and `applyFilters`.

The viewer session owns the applied metadata selection. The overlay owns its draft. One apply action updates the session and the current picker. Reopening the picker and follow refresh retain metadata selection. Keep the current text-query reopening behavior and existing all-trace next/previous navigation.

The picker displays its match count whenever text or metadata filters are active. Retain selection by trace ID when it still matches; otherwise select the first match. Enter does nothing with zero matches. The filter control remains available. A filter overlay opened with no matching trace has no originating trace ID, and its header shows no selected trace.

On the picker, Escape clears text editing/search first, then metadata selection, then follows current back behavior. Overlay Escape cancels the overlay before reaching the picker. Preserve Trace-screen `F` and lowercase `f` follow. While typing a query, `F` and `I` are query characters.

## Boundaries and acceptance

Implement only the setter, metadata event/reader contract, and local viewer integration. Keep legacy label configuration, compiler encoding, runtime forwarding, public eval records, Runs Explorer controls, and `std::tag` behavior intact. Automatic family tagging is outside this plan; existing agent names already identify historical Agency-agent traces.

Acceptance requires focused tests for precedence after real resume and subprocess starts, historical records, redaction, ordered extraction, compact display, and filter lifecycle. Use deterministic Agency-JS fixtures without model calls. Run `make` after stdlib changes, focused tests, type checks, structural lint, and formatting checks. Save command output.

Update stdlib source docstrings and developer docs. Generate the stdlib reference through `make`; do not hand-edit generated pages or user-facing guide pages.
