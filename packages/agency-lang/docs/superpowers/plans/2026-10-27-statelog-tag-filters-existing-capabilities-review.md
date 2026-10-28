# Existing capabilities review: StateLog run tags and filters

**Status:** Review of current code. The earlier spec and implementation plan are not ready to execute. This review replaces their assumptions about storage and scope; it does not approve a new implementation plan.

**Code inspected:** main at `b77f92377`, plus the documentation-only commits on `codex/statelog-tag-filters`. The review traced configuration, compiled configuration, runtime annotations, logger emission, resume and subprocess behavior, JSONL readers, upload/download clients, viewer controls, documentation, and relevant tests.

## Conclusion

The requested outcome is to find Agency-agent runs in mixed log files. Existing names already support identifying recorded runs. The single-file trace picker needs to display those names and provide an exact name filter.

For key/value labels, StateLog already has `log.metadata.custom: Record<string, string>`. It passes through configuration, compilation, runtime overrides, subprocess inheritance, and logging. A third storage field such as `tagValues` is unnecessary for string-valued tags.

There is still useful work to do. Agency has no public `std::statelog.setTags` setter, and the picker has no metadata columns or exact metadata filter controls. Existing filter composition and table rendering can support those additions.

I recommend using `custom` for the requested key/value tags and retaining its existing string value type. Keep legacy `tags: string[]` labels separate. Configuration-versus-setter precedence needs a defined contract before an executable plan is written.

## Requirements and assumptions

The user requested:

- Easier identification of Agency-agent runs.
- Agent names and key/value tags displayed and filterable in the logs viewer.
- A run-tag setter named `setTags`.
- A dense list with no extra metadata line under every entry.
- Examination of existing capabilities before deciding what to add.

The earlier plan introduced the following choices without establishing that the goal required them:

- A third metadata field, `tagValues`.
- Boolean, number, and null tag values.
- Conversion of legacy string labels into boolean key/value pairs.
- Allowing later configuration emissions to overwrite explicit setter values.
- Automatic `family="agency-agent"` tagging.
- Persistent text queries across reopening the picker.
- Changing next/previous trace navigation to use the filtered list.

Some of these could be useful. They should be evaluated separately rather than bundled into the minimum change.

## What already exists

| Capability | Verified behavior | Implication |
| --- | --- | --- |
| Agent names | `setAgentName` emits a separate `agentName` event. The Agency agent already calls it. | Existing files can gain name display and filtering without new log events. |
| String labels | `runMetadata.tags` is a string array. | There is already a run-label field. Preserve its type and stored values. |
| Key/value metadata | `runMetadata.custom` is a string dictionary. | Reuse this dictionary for key/value run tags. |
| Configuration | `agency.json`, generated TypeScript, invocation overrides, and effective logger configuration carry `custom`. | The proposed string-valued API does not require a new configuration field or compiler encoding. |
| Logger API | Public `StatelogClient.runMetadata` accepts metadata and emits an event. | A stdlib wrapper can use the existing writer. |
| Redaction and sinks | Events use the shared redaction path and the same serialized envelope for file, stdout, and HTTP. | A setter should preserve this path and the original tagged object until redaction. |
| Value tags | `std::tag.setTags(value, tags)` attaches tags to a value. | It does not label a run. Its redaction behavior already applies to logged values. |
| Picker text search | Search visits string values in event payloads, including names and custom metadata. | Approximate search works today; exact name or key/value matching does not. |
| Filter composition | `TraceFilter` declares a predicate; `applyFilters` combines predicates with AND. The picker has an unused `extraFilters` slot. | Extend the existing mechanism. A second filtering engine is unnecessary. |
| Multi-file Runs Explorer | Its rows already include agent names, with grouping and sorting. | This does not replace the single-file picker, but it is existing functionality to reuse as a pattern. |
| CSV and trace selection | CSV extraction includes the recorded agent name. `--trace-id` selects a trace by exact ID or unique prefix. | Existing workflows already help locate named runs. |

Sources: [metadata and client configuration](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/statelogClient.ts:72), [configuration schema](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/config/config.ts:560), [compiler forwarding](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/backends/typescriptBuilder.ts:4564), [Agency naming API](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/stdlib/statelog.agency:80), [bundled agent naming](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/agents/agency-agent/agent.agency:117), [existing filter interface](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/logsViewer/traceSearch.ts:11), [picker filter slot](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/logsViewer/screens/tracePicker.ts:55), [Explorer agent column](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runsExplorer/views/runsTableView.ts:254), [CLI routing and trace selection](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/cli/logsView.ts:96).

For example, this configuration is already supported:

```json
{
  "log": {
    "metadata": {
      "tags": ["interactive"],
      "custom": {
        "family": "agency-agent",
        "project": "agency-lang"
      }
    }
  }
}
```

With observability and a log sink enabled, this configuration labels runs started with it. A runtime setter would allow the program to choose values during execution.

## Is run metadata reserved for machine information?

No. Its declared fields already mix application metadata with runtime context.

| Location | Current contents and source |
| --- | --- |
| Outer log envelope | Format version, trace ID, project ID, span ID, parent span ID. The logger constructs these. |
| `agentStart` event | Entry node, arguments, optional input, and code identity. |
| `agentName` event | The name supplied through `setAgentName`. |
| `runMetadata` event | Configurable labels, environment, user ID, agent version, and custom string pairs. The writer also accepts optional module name and entry node. |
| Configuration emission | `agentStart` emits configured metadata and sets its actual entry node on that event. |

Users can already supply the application fields through configuration. `custom` already provides a separate namespace for their key/value data. A custom key named `type` or `entryNode` stays nested inside `custom`; it does not replace the event's outer fields.

There is a narrower writer issue. `runMetadata` spreads its argument after `type: "runMetadata"`. Unvalidated JavaScript could pass an extra top-level `type` and change the event discriminator. Validated configuration strips unsupported metadata fields. The outer trace and span identifiers are constructed separately and are not overwritten by this spread.

This merits a small writer-hardening change if that API boundary is addressed. It does not justify another user metadata dictionary.

Sources: [metadata event writer and startup emission](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/statelogClient.ts:1110), [envelope construction](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/statelogClient.ts:1687), [validated configuration fields](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/config/config.ts:560), [trusted invocation forwarding](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runtime/invocationOptions.ts:175).

## Lifecycle findings that affect the design

### Agent names describe the latest recorded name in a trace

Both eval extraction and the Runs Explorer use the last valid string `agentName` event. The stdlib documentation describes this rule. There is no separate root-agent name field.

A child that calls `setAgentName` in the same trace can therefore change the displayed name. Merely having a named subagent does not establish that it emits this event; thread labels are a separate mechanism. Preserve the existing name meaning unless root-agent identity becomes an explicit requirement.

A stable family tag could make Agency-agent runs easier to find even after renaming. That is an optional convention for future runs. It cannot recover missing labels in historical files.

Sources: [documented name semantics](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/stdlib/statelog.agency:87), [eval name extraction](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/eval/extract.ts:126), [Explorer name extraction](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runsExplorer/mine.ts:168).

### Resume and subprocess starts repeat configured metadata

`runMetadata` emits an event. It does not update the client's configured `metadata`. Every `agentStart` emits that configured metadata again. This includes interrupt resume and subprocess starts within the same trace.

Consequently, the earlier plan's last-event-wins rule would produce:

```text
configuration: project="configured"
setter:        project="website"
resume:        project="configured"  <-- configuration emitted again
```

The setter's completed statement is skipped on resume. It does not run again to restore `"website"`.

I recommend treating configuration as defaults and allowing explicit setters to override those defaults. Current events do not carry a reliable, documented distinction between configured defaults and explicit updates. Configuration emissions currently include `entryNode`, but inferring origin from its presence would create a hidden dependency. A replacement plan must define that distinction explicitly, specify how to read historical events that lack it, and test resume and subprocess behavior. A narrow event-origin addition may be warranted; another tag storage field is not needed for it.

Subprocess inheritance forwards effective configured metadata. Parent metadata replaces the child's metadata override on the normal shared-sink path. An explicit child log file or disabled parent observability bypasses that inheritance. Prior setter events are not configuration and are not forwarded as configuration.

Sources: [configured metadata emission](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/statelogClient.ts:1139), [resume startup](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runtime/interrupts.ts:985), [subprocess metadata inheritance](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runtime/ipc.ts:1396), [branch-bound logger](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/statelogClient.ts:292).

### A saved trace and a new trace are different scopes

Existing branch loggers share the trace identity. A reader can derive current labels from all events in that trace.

A rewind can create a new trace without replaying already-completed naming or tagging calls. A file that contains only the resumed portion of a trace can also lack earlier annotations. These are existing limits of event-based annotations, including agent names. Do not promise that every new trace or partial log automatically contains all earlier metadata.

Adding checkpoint state or replaying annotations would expand the feature. The present goal does not establish that need.

Source: [rewind execution](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runtime/rewind.ts:77).

### Value tags and redaction remain relevant

The value-tag system tags values, including values subsequently written as run metadata. Primitive tags match by value. Plain extensible objects and arrays have durable tags that survive supported state round trips. Other objects use a reference-based fallback that is branch-local.

Some comments in `stdlib/tag.agency` still describe all object tags as branch-local. That description is stale. It must not be used to justify a new persistence mechanism.

A setter should validate without copying its input before logging. Copying a tagged dictionary can lose its object-level redaction marker. A reader must tolerate a whole dictionary replaced with a redaction string. Redaction replacement strings cannot reliably be distinguished from literal strings in a saved log.

Sources: [durable and fallback object tags](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runtime/state/globalStore.ts:16), [redaction traversal](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runtime/redactForStatelog.ts:25), [tag round-trip and copy tests](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runtime/revivers/taggedReviver.test.ts:11), [stale stdlib comments](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/stdlib/tag.agency:1).

## What the viewer actually needs

The single-file trace picker and the per-trace Overview are different screens. The picker lists traces. Overview displays activity within one trace. Metadata belongs in the picker and selected-trace details without adding lines under every Overview entry.

The recommended viewer scope is:

1. Derive each trace's recorded name and key/value metadata from its original event order.
2. Add a bounded Agent column and a compact optional metadata column using the existing table component.
3. Provide access to the full metadata for the selected trace without permanent extra rows.
4. Turn selected names and key/value conditions into existing `TraceFilter` predicates.
5. Keep applied metadata selection when the picker is recreated or follow mode refreshes its data.
6. Include custom metadata in the event summary, which currently renders only legacy `tags`.

Exact filtering and dense metadata display follow directly from the request. Full-metadata access, selection persistence, and better event summaries are recommendations for making that workflow usable.

Name filters should match recorded names, so a name mentioned in a prompt does not count. Key/value filters should require both the key and its exact string value. Text search can continue to compose with these predicates through `applyFilters`.

Compute metadata in the existing input-order pass. The rendered span tree groups and sorts events, so walking that tree can produce the wrong latest value. Equal or misleading timestamps should not alter file-order semantics.

The existing table owns width allocation, clipping, and painting. Declare column widths and visibility choices as data. Keep one primary row per trace. Existing annotation rows do not provide a reason to add metadata rows.

The filter screen can keep draft choices locally and commit one selection on apply. Escape should discard the draft. The session needs applied metadata selection because opening the picker creates a new instance. Moving every existing picker state field into the session is not required.

Sources: [trace summaries](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/logsViewer/traceSummaries.ts:9), [forest construction](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/logsViewer/tree.ts:100), [picker matching](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/logsViewer/screens/tracePicker.ts:173), [picker reconstruction](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/logsViewer/run.ts:528), [table layout](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/tui/table.ts:59), [current metadata summary](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/logsViewer/summary.ts:98).

## Proposed build using existing capabilities

| Area | Proposed addition | Existing capability to reuse |
| --- | --- | --- |
| Agency API | `std::statelog.setTags` accepting string key/value pairs | The current-run pattern used by `setAgentName`, and `runMetadata({ custom: tags })` |
| Metadata interpretation | One ordered reader with documented patch and precedence rules | Existing event payloads and the initial per-trace input pass |
| Update origin, if setters override defaults | Explicit distinction between defaults and setter patches, plus a reading rule for historical events | Existing `runMetadata` events and `custom` storage |
| Exact filtering | Name and key/value predicates plus selection controls | `TraceFilter`, `applyFilters`, picker filtering |
| Display | Compact columns, selected-trace metadata, custom event summaries | Table, overlay, detail-view, and safe text-rendering components |
| Verification | Setter, lifecycle, projection, and UI tests | Existing deterministic Agency-JS and Vitest patterns |
| Documentation | API semantics and viewer controls | Stdlib source docstrings and developer docs |

The final size depends on the precedence rule. A wrapper and an ordered reader suffice for last-event-wins behavior, including its resume resets. The recommended rule, where setters override defaults, also requires the explicit origin distinction above. Reusing `custom` resolves the storage question; it does not resolve update precedence.

Recommended scope decisions:

- Use existing `custom` entries as filterable key/value tags, including those in old logs.
- Keep string values. Richer scalar types were an assistant-added choice.
- Treat each setter call as a patch: supplied keys replace their prior explicit values; omitted keys remain.
- Preserve legacy `tags` labels without converting them to boolean values or widening their configuration type.
- Resolve defaults-versus-explicit-update semantics before implementation.
- Preserve existing text-query reopening behavior unless query persistence is separately chosen.
- Treat filtered next/previous navigation and automatic family tagging as optional additions.
- Keep public eval records and Runs Explorer schemas unchanged unless a new consumer requires them.

## Anti-pattern assessment

The earlier plan failed the catalog's **duplicating existing code** principle by planning a new key/value storage contract before accounting for `custom`. Its optional query-persistence and filtered-navigation changes also expanded the scope without establishing the need.

Its proposed pure metadata projection and declarative predicates were useful boundaries. Those abstractions did not establish that the proposed storage was necessary.

The revised direction should encapsulate imperative work in a few existing places:

| Declarative input | Boundary that owns the work |
| --- | --- |
| A tag patch | The stdlib wrapper validates and emits through the logger |
| Ordered events | One reader derives current trace metadata |
| Selected names and key/value conditions | Predicate construction feeds existing filter composition |
| Column definitions | The existing table allocates widths, clips, and renders |
| Apply/cancel actions | The existing view/session boundary commits or discards a draft |

Do not spread metadata field checks or patch merging across the picker, summaries, and filter view. Do not ask UI callers to coordinate mutable name and tag state. Event order is a required input to the reader; it should not become hidden setter ordering across consumers.

Source: [anti-pattern catalog](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/docs/dev/contributing/anti-patterns.md:5).

## Additional discrepancies and limits

- **Configuration strips `__proto__`.** The config merge code removes that key recursively, even when no local override exists. The earlier promise that this key survives every path is false. Preserve this hardening and specify setter validation accordingly. See [config merge](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/config/merge.ts:19) and [config loading](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/config/target.ts:67).
- **Custom metadata is poorly exposed today.** The trace event summary ignores it, and the picker summary has no field for it. The raw data is retained. This is a reader/display gap.
- **Runs Explorer has a separate focus limitation.** Opening a raw-trace row does not pass its trace ID into the viewer, while some other row types do. That can reopen the picker. Record this separately instead of expanding this feature into general Explorer work. See [Explorer open-log actions](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/runsExplorer/views/runsTableView.ts:201).
- **Client transport preserves payloads, but hosted semantics are unverified.** Upload keeps the envelope, download accepts arbitrary event data, and local parsing retains it. The hosted storage/viewer implementation is outside the inspected repository. Reusing `custom` preserves the existing field shape; it does not prove the server's behavior for repeated metadata updates or concurrent arrival order. See [upload envelopes](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/cli/statelog/evalUploadClient.ts:147), [download schema](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/cli/statelog/projectClient.ts:74), and [download-to-JSONL bridge](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/lib/cli/remote/logsBridge.ts:15).

## Verification

The focused baseline passed: **6 test files, 167 tests**.

```sh
node node_modules/vitest/vitest.mjs run \
  lib/statelogClient.test.ts \
  lib/config/config.test.ts \
  lib/config/merge.test.ts \
  lib/logsViewer/traceSearch.test.ts \
  lib/logsViewer/screens/tracePicker.test.ts \
  lib/runsExplorer/mine.test.ts \
  --exclude '**/worktree*/**'
```

The run used the main checkout at the same code commit. It excluded nested worktree copies. Output is saved at [test output](/tmp/statelog-tag-audit-direct-tests.log). The normal pnpm invocation stalled without starting tests, so the installed Vitest entry point ran the same focused selection.

These checks establish the existing baseline. They do not validate the proposed setter or metadata projection. No feature code changed, no paid model calls ran, and the full Agency test suite was not run.

A replacement implementation plan should add coverage for:

- Existing custom configuration through compiled execution and logging.
- A compiled setter using the real file sink.
- Repeated setters, independent traces, interleaved spans, and input-order projection.
- Resume and subprocess emissions under the chosen precedence rule.
- Scalar and whole-dictionary redaction.
- Existing legacy labels without type conversion.
- Exact metadata filters combined with text search.
- Dense rendering at narrow widths, navigation back to the picker, follow refresh, and zero matches.

The existing tests cover pieces of these paths. They do not yet establish a complete custom-metadata-to-picker contract.
