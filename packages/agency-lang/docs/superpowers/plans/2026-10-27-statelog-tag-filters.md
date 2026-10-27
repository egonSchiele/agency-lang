# StateLog Tag Filters Implementation Plan

> **Not ready for implementation.** The [existing-capabilities review](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/docs/superpowers/plans/2026-10-27-statelog-tag-filters-existing-capabilities-review.md) found that the proposed `tagValues` storage duplicates `runMetadata.custom`. It also identifies unresolved configuration-versus-setter precedence and unnecessary scope. The steps below are retained for reference and require replacement before execution.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify complete runs by agent name and key/value tags, with filters and a single-line trace list.

**Architecture:** `std::statelog.setTags` records patches in existing `runMetadata` events. A shared pure projection derives current metadata in file order, and the viewer composes declarative predicates over that result. The session owns filters; overlays own draft edits and rendering.

**Tech Stack:** Agency, TypeScript, Zod, the existing `lib/tui` components, Vitest, and deterministic Agency-JS fixtures. No new dependencies.

**Spec:** [Agent names and run tags in the logs viewer](../specs/2026-10-27-statelog-tag-filters-design.md).

## Global Constraints

- Work in this task's worktree, created from main at `b77f92377`, on `codex/statelog-tag-filters`. Paths below are relative to its `packages/agency-lang` directory.
- Expose `setTags` from `std::statelog`; merge supplied keys and preserve omitted keys.
- Tag values are strings, finite numbers, booleans, or null. Null is a value, not deletion.
- Preserve old `runMetadata.tags` string arrays; write key/value pairs as additive `runMetadata.tagValues`.
- Use file order for metadata, including later configuration emissions. Do not derive it by walking the rendered span tree.
- Keep one primary line per trace. Add no per-run metadata lines and leave Overview's call layout unchanged.
- Use types, plain objects, arrays, and static imports. Do not introduce maps, sets, dynamic imports, symlink support, or new dependencies.
- Keep handlers, interrupts, checkpoints, and `std::tag` semantics unchanged.
- Run `make` after stdlib changes. Generate stdlib references from `.agency` doc comments; never hand-edit generated pages or `.js` siblings.
- Update developer docs and stdlib source comments; leave `docs/site/guide/` out of this feature change.
- Save test/build output to files. Run focused tests, not the full Agency suite, and make no paid model calls.
- Before each task's commit, format its changed TypeScript files with Prettier using explicit paths and run `pnpm run typecheck`. Save each command's output under `/tmp/statelog-tag-task-N-{format,types}.log` and require exit 0. Keep the final package-wide formatting check.
- Write commit messages to a file and use `git commit -F`; never amend or force push.

## Review Focus

1. Interleaved sibling spans and misleading/equal timestamps must not change which tag/name update wins. Pin this in Tasks 1 and 3.
2. Missing tags, null, false, zero, empty strings, and hostile property names must remain distinguishable and safe. Pin this in Tasks 1, 2, and 4.
3. Legacy logs and re-emitted configuration patches must follow the documented compatibility/order rules. Pin this in Tasks 1 and 2.
4. A narrow terminal or a long tag must not create extra trace rows or hide access to full metadata. Pin this in Task 3.
5. Enter/Escape, follow refreshes, zero matches, and trace stepping must preserve filters and focus correctly. Pin this in Task 4.

## File structure and responsibilities

| Area | Files | Responsibility |
| --- | --- | --- |
| Metadata contract | New `lib/statelog/runMetadata.ts` and `.test.ts` | Scalar validation, legacy normalization, writer encoding, ordered projection |
| Name accessor | `lib/statelog/wireAccessors.ts` and `.test.ts` | Read one agent-name event without requiring tag state |
| Writer/config | `lib/statelogClient.ts`, `lib/config/config.ts`, their tests; `lib/backends/statelog.codegen.test.ts`, `lib/runtime/ipc.test.ts` | Accept tags from configuration, preserve the wire contract, and verify existing subprocess inheritance |
| Agency API | `stdlib/statelog.agency`, `lib/stdlib/statelog.ts`, `.test.ts`; `lib/agents/agency-agent/agent.agency` | Public setter and automatic family tag |
| API integration | New `tests/agency-js/set-statelog-tags/{agent.agency,test.js,fixture.json,agency.json}` | Prove config, compiled setters, and interrupt resume emit correct metadata without an LLM |
| Metadata consumers | `lib/logsViewer/{types,tree,traceSummaries}.ts`, `lib/eval/extract.ts`, `lib/runsExplorer/mine.ts`, existing tests | Consume one projection; retain existing external eval/scanner shapes |
| Dense display | `lib/logsViewer/screens/tracePicker.ts`, `screens/chrome.ts`; new `views/traceMetadataView.ts`, matching tests | Single-line columns, shared header, full metadata overlay |
| Filters | New `lib/logsViewer/traceFilters.ts`, `views/traceFiltersView.ts`, matching tests | Pure predicates, options, edits, matching results, and keyboard-driven draft selection |
| Session integration | `lib/logsViewer/run.ts`, `views/view.ts`, `screenHost.ts` only where needed, shell/lifecycle tests | Apply selection commands in one place; own overlay actions, navigation and follow |
| Documentation | `docs/dev/hosting/statelog.md`, `docs/dev/runtime/config.md`, `docs/dev/cli/logs-viewer.md` | API scope, compatibility, controls and matching rules |

Do not change `OverviewScreen`, `overviewData`, or `overviewCharts` to add metadata to calls. Do not add fields to public eval records or Runs Explorer rows without a consumer in this scope.

## Declarative boundaries

| Caller declares | Boundary owns |
| --- | --- |
| A metadata patch or an ordered sequence of events | Validation, wire compatibility, merging, and name extraction |
| Selected agent names, tag conditions, and text query | Predicates and one matching result used by rows, counts, and navigation |
| A selection edit | One session operation replaces selection and refreshes its derived result |
| Column definitions with widths and visibility priority | One column selector chooses what fits; `TableComponent` measures, clips, and paints |
| A keybinding or overlay action | Existing keymap dispatch and shell side effects |

Event order is an input to the metadata reducer. Callers do not coordinate mutable tag/name fields. Keep compatibility checks inside the metadata module, field predicates inside `traceFilters.ts`, and viewport decisions inside the picker column selector. Existing layout helpers retain width allocation; do not reimplement it.

## Execution preflight

- [ ] Read this spec, the package's `CLAUDE.md`, and the four contributing guides. Inspect the worktree status and preserve unrelated changes.
- [ ] Before planning or writing the resume fixture, read the interrupt lifecycle in `CLAUDE.md`, `docs/site/guide/{interrupts,handlers,effects,policies}.md`, and `docs/dev/runtime/{interrupts,checkpointing,subprocess-ipc}.md`. Reuse public resume APIs and existing fixture patterns; do not modify handler registration or checkpoint internals.
- [ ] If dependencies are absent, run `pnpm install --frozen-lockfile > /tmp/statelog-tag-install.log 2>&1` from the worktree's repository root. Require exit 0 before implementation; do not change the lockfile to make setup pass.
- [ ] From `packages/agency-lang`, run the existing metadata/viewer baseline: `pnpm test:run lib/statelogClient.test.ts lib/stdlib/statelog.test.ts lib/logsViewer/traceSummaries.test.ts lib/logsViewer/traceSearch.test.ts lib/logsViewer/screens/tracePicker.test.ts > /tmp/statelog-tag-baseline.log 2>&1`. Inspect any failures before attributing them to the feature.

## Task 1: Define ordered run metadata and compatible storage

**Files:** Metadata contract, name accessor, and writer/config rows above; `lib/statelogClient.test.ts`, `lib/config/config.test.ts`, `lib/backends/statelog.codegen.test.ts`, `lib/runtime/ipc.test.ts`.

**Interfaces produced in `lib/statelog/runMetadata.ts`:**

```ts
type RunTagValue = string | number | boolean | null;
type RunTags = Record<string, RunTagValue>;
type TraceMetadata = { agentName?: string; tags: RunTags };
type RunMetadataPatch = { tags?: string[]; tagValues?: RunTags };

validateRunTags(value: unknown): RunTags;
encodeRunTags(tags: RunTags | string[]): RunMetadataPatch;
emptyTraceMetadata(): TraceMetadata;
applyTraceMetadata(previous: TraceMetadata, data: Record<string, unknown>): TraceMetadata;
traceMetadata(events: readonly EventEnvelope[]): TraceMetadata;
```

Export the types/functions. Validation checks a plain record and returns the same object, preserving object-level redaction. Invalid input throws a descriptive error naming the invalid key without echoing its value. The read projection tolerates malformed saved entries; write validation is strict. `traceMetadata` reduces ordered events through `applyTraceMetadata`.

Add `agentNameOf(event: EventWithData): string | undefined` to the existing `lib/statelog/wireAccessors.ts`, with `type EventWithData = { data: unknown }`. It reads only a valid string name on an `agentName` event. Use it inside the metadata reducer and in name-only consumers. A streaming consumer passes `{ data: payload }` and retains only its existing name field.

- [ ] Write failing metadata tests with these assertions:
  - Legacy `{ tags: ["interactive"] }` becomes `{ interactive: true }`.
  - Patches `{ project: "agency", ready: false }`, then `{ project: "site" }`, yield `{ project: "site", ready: false }`.
  - Null, zero, and `""` survive. `{}` preserves prior tags.
  - An event with legacy `tags: ["ready"]` and `tagValues: { ready: false }` yields `ready: false`.
  - A later event wins despite an earlier/equal timestamp or a different span. Events of unrelated types cannot change metadata.
  - A separate `agentName` event sets the name, a later valid one replaces it, and a non-string name is ignored without losing the prior name or tags.
  - `__proto__` and `constructor` remain own values, with no prototype mutation. Invalid entries in a saved record do not discard valid siblings.
  - Reject empty keys, nested values, arrays passed to the public validator, nonfinite numbers, undefined, and non-record roots atomically.
- [ ] Run the focused tests and confirm the new behavior fails. Save output to `/tmp/statelog-tag-contract-red.log`.
- [ ] Implement the contract using one scalar predicate, one writer adapter, and one projection. Own the only key-merging logic here. Avoid stringify/parse copies that lose references before StateLog redaction.
- [ ] Test `agentNameOf` with valid names, non-name events, and malformed data. The accessor returns undefined for a non-name event even when it contains a `name` field. Metadata reduction and name-only consumers must not repeat its wire-field checks.
- [ ] Widen the handwritten configuration and Zod types for `log.metadata.tags` to `RunTags | string[]`. Reuse the scalar constraint. Keep string-array configuration accepted. `StatelogClient.runMetadata` uses `encodeRunTags` so array input keeps `data.tags`, object input emits `data.tagValues`, and unrelated metadata fields remain unchanged.
- [ ] Add writer/config/codegen tests: record config is accepted; legacy array bytes retain their existing shape; object tags generate `tagValues` without an object-valued `tags` field; invalid config fails; `agentStart` still emits configured metadata. The existing builder uses `JSON.stringify`; change its implementation only if these tests reveal a need.
- [ ] Pin repeated-start behavior: configured `{ project: "configured" }`, a setter-style metadata patch `{ project: "website", programOnly: true }`, then another configured emission resolves to `{ project: "configured", programOnly: true }`. Interrupt resumes and subprocess starts/resumes call `agentStart` again and trigger this emission. This is source-order patch behavior, not persistence in a checkpoint.
- [ ] Extend `withParentStatelog` tests in `lib/runtime/ipc.test.ts` with key/value metadata: parent effective metadata replaces the child's metadata override; an explicit child `logFile` or disabled parent observability bypasses inheritance. Verify the existing run and resume instruction paths both receive these overrides. Keep this runtime behavior unchanged; setter events do not alter configuration.
- [ ] Run `pnpm test:run lib/statelog/runMetadata.test.ts lib/statelog/wireAccessors.test.ts lib/statelogClient.test.ts lib/config/config.test.ts lib/backends/statelog.codegen.test.ts lib/runtime/ipc.test.ts > /tmp/statelog-tag-contract.log 2>&1`. Require exit 0. Inspect the saved failure output if needed. Format the changed TypeScript files, then run `pnpm run typecheck > /tmp/statelog-tag-task-1-types.log 2>&1`, including the existing per-invocation config consumers; require exit 0.
- [ ] Commit the contract with a message file: `feat: define compatible key-value run metadata`.

## Task 2: Expose `std::statelog.setTags` and tag Agency agent runs

**Files:** Agency API/integration rows above; `lib/statelogClient.redaction.test.ts`; StateLog and configuration documentation.

**Consumes:** `RunTags`, `validateRunTags`, and the existing `runMetadata` writer from Task 1.

**Produces:**

```agency
export type StatelogTagValue = string | number | boolean | null
export def setTags(tags: Record<string, StatelogTagValue>) {
  _setRunTags(tags)
}
```

TypeScript implementation: `_setRunTags(tags: RunTags): Promise<void>` in `lib/stdlib/statelog.ts`. Keep the public Agency name `setTags` and leave `lib/stdlib/tag.ts`'s `_setTags(value, tags)` unchanged.

- [ ] Write failing tests for `_setRunTags`: posts a metadata patch through the current branch-bound logger, rejects invalid input before emission, is a no-op outside a run like other statelog annotations, and emits no event for `{}`. Keep valid-input validation independent of whether logging is enabled.
- [ ] Add redaction coverage using the real file sink: a marked scalar is scrubbed, a tags object marked with `std::tag.redact` is replaced as a whole, and trace/span envelope fields remain intact. A fully redacted `tagValues` payload is safely ignored by the read projection.
- [ ] Implement the thin wrapper with no new mutable client, global, or checkpoint state. Add accurate module/function docs describing trace scope, scalar types, merge behavior, null, and configuration re-emission on resume/subprocess start. The function docstring says it sets tags on this run's trace, shown in the logs viewer, and points to `std::tag` for value tags. Include `import { setTags as setRunTags } from "std::statelog"` as the alias when using both setters.
- [ ] Import `setTags` into the bundled agent and record `{ family: "agency-agent" }` next to its existing `setAgentName` call. Keep subagent thread labels and agent-name rules unchanged.
- [ ] Create the deterministic Agency-JS fixture following `tests/agency-js/set-agent-name`. Configure `log.metadata.tags` as an object in `agency.json`; assert its initial event uses `tagValues`. Call `setTags` twice and from a helper, assert one trace contains all patches, check the final merged values, and verify the program's ordinary return value. Use no LLM calls. Keep fixture files inside this worktree.
- [ ] Add a resume case using the exported `respondToInterrupts` API and an existing deterministic resume fixture as the pattern. With configured `{ project: "configured" }`, call `setTags({ project: "website", programOnly: true })`, then raise an interrupt. Before approval, assert `project` is `"website"`; after approval and resume, assert `project` is `"configured"` and `programOnly` remains true. Assert one trace ID, the setter emitted once, and the ordinary return value. The setter must not be replayed, and the test must not bypass the handler chain.
- [ ] Run `pnpm test:run lib/stdlib/statelog.test.ts lib/statelogClient.redaction.test.ts > /tmp/statelog-tag-api.log 2>&1`; require exit 0. Run `make > /tmp/statelog-tag-build.log 2>&1`, then `pnpm run agency test js tests/agency-js/set-statelog-tags > /tmp/statelog-tag-agency-js.log 2>&1`; require both to pass.
- [ ] Review generated changes and retain only those caused by this API/docs update. Format changed TypeScript files, then run `pnpm run typecheck > /tmp/statelog-tag-task-2-types.log 2>&1`; require exit 0. Commit with message file `feat: expose statelog setTags for complete runs`.

## Task 3: Project metadata once and keep the trace list single-line

**Files:** Metadata consumers and dense-display rows above; `lib/logsViewer/views/view.ts`, `run.ts`; their existing tests and new `traceMetadataView.test.ts`.

**Consumes:** `TraceMetadata`, `applyTraceMetadata`, `traceMetadata` from Task 1.

**Produces:** A `metadata?: TraceMetadata` field on trace roots in `TreeNode`; `agentName?: string` and `tags: RunTags` on `TraceSummary`; a `traceMetadata` view/action using `traceId` as its stable identity.

- [ ] Add failing tests for interleaved traces and sibling spans whose tree order differs from input order. Assert that `buildForest` plus `traceSummaries` agrees with `traceMetadata(events)` per trace. Include no metadata and same-timestamp updates.
- [ ] Accumulate metadata into each trace root during `buildForest`'s existing input-order pass. Do not walk/sort the finished forest to decide which value wins. `traceSummaries` reads the root metadata directly.
- [ ] Reuse `agentNameOf` in `lib/eval/extract.ts` and the streaming scanner `lib/runsExplorer/mine.ts`. Keep their existing public shapes and last-name behavior; add parity tests against the viewer. Do not construct and discard a full tags record for these name-only reads.
- [ ] Define responsive columns as data over the existing `TableColumn` renderer. Give Agent a fixed `AGENT_COLUMN_CELLS = 25`, including its trailing gap. Keep the existing 5-cell Hits column while text search is active. Drop optional columns in order: Tags, Context, LLM calls. Keep selection in one picker-local helper. Set `MIN_PROMPT_CELLS = 24` for content and reserve its trailing gap separately; use existing `MIN_COLS` for the terminal minimum. Reuse `TableComponent` and its width allocator; do not extend its width API. Tags use a stable sorted-key summary, quoted string values, and terminal-safe clipping. Add no tag lines to `traceNote`.
- [ ] Write rendering tests at widths 100, 128, and 180: exactly one primary line per run, tag count does not affect body height, optional columns give way in the declared order, and existing annotation/comment rows are unchanged. At 100 columns, include a 200-character agent name and active text search; assert Hits stays visible and prompt content has at least 24 cells. Include long Unicode values and terminal-control text.
- [ ] Add the full metadata overlay with the existing keymap, scrolling, and safe painters. `I` opens it for the selected picker trace or current open trace; declare its shell binding with `when: () => !controls.typing`. Display a clear empty state for unnamed/untagged logs. Keep full values reachable even when the compact table clips them.
- [ ] Add the selected agent name to the existing shared header without increasing its height. Nested overlays must keep their originating trace ID, rather than switching the header to the underlying screen's trace. Escape closes metadata and restores the same selection.
- [ ] Run `pnpm test:run lib/logsViewer/tree.test.ts lib/logsViewer/traceSummaries.test.ts lib/logsViewer/screens/tracePicker.test.ts lib/logsViewer/screens/chrome.test.ts lib/logsViewer/views/traceMetadataView.test.ts lib/eval/extract.test.ts lib/runsExplorer/mine.test.ts > /tmp/statelog-tag-display.log 2>&1`; require exit 0. Review intended snapshots.
- [ ] Format changed TypeScript files, then run `pnpm run typecheck > /tmp/statelog-tag-task-3-types.log 2>&1`; require exit 0. Commit with message file `feat: show run identity without expanding trace rows`.

## Task 4: Add typed metadata filters and preserve them through navigation

**Files:** Filters/session-integration rows above, `screens/tracePicker.ts`, `traceSearch.ts`, `run.shell.test.ts`, `run.test.ts`, `screenHost.test.ts`, `escLadder.test.ts`.

**Consumes:** Task 3's trace summaries and existing `TraceFilter`/`applyFilters`/`textFilter`.

**Produces in `lib/logsViewer/traceFilters.ts`:**

```ts
type TagCondition = { key: string; value: RunTagValue };
type MetadataSelection = { agentNames: string[]; tags: TagCondition[] };
type TagChoices = { key: string; values: RunTagValue[] };
type MetadataChoices = { agentNames: string[]; tags: TagChoices[] };
type TracePickerState = { query: string; metadata: MetadataSelection };
type TracePickerEdit =
  | { kind: "setQuery"; query: string }
  | { kind: "setMetadata"; metadata: MetadataSelection };
type VisibleTraces = {
  summaries: TraceSummary[];
  hits: TraceHit[];
  filters: TraceFilter[];
};

metadataChoices(summaries: readonly TraceSummary[]): MetadataChoices;
metadataFilters(selection: MetadataSelection): TraceFilter[];
editTracePickerState(state: TracePickerState, edit: TracePickerEdit): TracePickerState;
projectTraces(
  summaries: readonly TraceSummary[],
  texts: readonly TraceText[],
  state: TracePickerState,
): VisibleTraces;
```

The session owns `TracePickerState`. Views receive read-only snapshots and an `editSelection(edit: TracePickerEdit): void` command bound to one shell operation. They never assign the shared query, mutate selected arrays, or rebuild predicates. Query entry, Escape clearing, and applying the filter draft all call this command. This works with the current `View.escape(): boolean` contract without changing every screen's return type.

The shell's edit operation replaces state through `editTracePickerState`, computes `projectTraces`, and passes the result to the picker. Follow updates use the same projection with new input data. Picker rows, header counts, and trace stepping consume that one result; they do not each repeat search/filter composition. Treat the result as derived data, not a separately editable cache. The filter overlay owns its draft and emits one `setMetadata` command on apply; cancel emits none.

- [ ] Add pure failing tests: any selected agent, all tag keys, exact scalar equality, missing versus null, combined metadata/text filters, empty selection, and zero matches. A name appearing only in prompt text must not satisfy the name predicate. `"true"` must not match `true`. State edits must not mutate their inputs, a query edit must preserve metadata selection, and a metadata edit must preserve the query.
- [ ] Test redaction replacements as saved strings: default `[REDACTED]` and custom replacements are displayed and filterable, with the same equality as literal strings of that spelling. Do not infer redaction from a string's text; the wire format has no such marker. Ensure the original secret never appears in saved-data choices and that a whole-object replacement contributes no tag choices.
- [ ] Implement predicate/choice derivation through the existing `TraceFilter` interface. Keep key existence checks own-property-safe. Derive options from all traces; retain unmatched active selections in the overlay.
- [ ] Build `TraceFiltersView` with the existing `View`, table, keymap and scrolling helpers. Use Agents and Tags sections; tag selection chooses a key then an observed typed value. Space toggles an agent/value, Enter applies, Escape cancels, and Clear filters clears the draft. At most one selected condition per key. Do not create a generalized form system or a new search syntax.
- [ ] Wire an explicit `openTraceFilters` action to uppercase `F` in the picker's browsing keybindings. Preserve the Trace screen's existing `F` quick-filter action. Add metadata/filter overlay names and actions to `views/view.ts`. Bind `editSelection` to the shell operation above. Keep overlay construction and state application in the shell; the renderer must not perform file reads or navigation side effects.
- [ ] Persist both query and metadata selection across `createHost`/`makeActions.openPicker`, which currently construct fresh pickers with empty text queries. Query persistence is intentional. Use `projectTraces` for picker rows, `<`/`>` stepping, and the trace-position count. Keep cursor reconciliation inside the picker when it receives the result; the shell must not reset a cursor or scroll field directly. Preserve an already-open trace when new metadata excludes it. Show `outside filters · N matches` in its header. From that trace, next selects the first match and previous selects the last, including when there is exactly one match; do not retain `ScreenHost.stepTrace`'s early return for that case.
- [ ] Use the picker's existing search/status chrome for active filters and match count; do not add per-run lines. Only the payload text query is forwarded to `selectTrace`; metadata-only filtering opens Overview.
- [ ] Add scripted lifecycle tests: draft apply/cancel/clear; Enter into a run then Escape back; follow updates while either overlay is open; an open trace becoming excluded with zero, one, and several matches; selected trace removal; filtered stepping and counts; Escape clearing text before metadata; and ordinary `f`, `q`, number keys, help, and single-trace metadata access retaining their meanings. Assert that an excluded trace never displays position `0/N`.
- [ ] Add explicit regressions for context and persistence: type `FIX` into the picker's `/` search and assert the full query with no overlay opened; verify `F` still cycles the quick filter on the Trace screen; reopen the picker through both `t` and Escape and verify query plus metadata selection survive; follow a file update and verify both remain active.
- [ ] Run `pnpm test:run lib/logsViewer/traceFilters.test.ts lib/logsViewer/traceSearch.test.ts lib/logsViewer/views/traceFiltersView.test.ts lib/logsViewer/screens/tracePicker.test.ts lib/logsViewer/run.shell.test.ts lib/logsViewer/run.test.ts lib/logsViewer/screenHost.test.ts lib/logsViewer/escLadder.test.ts > /tmp/statelog-tag-filters.log 2>&1`; require exit 0.
- [ ] Format changed TypeScript files, then run `pnpm run typecheck > /tmp/statelog-tag-task-4-types.log 2>&1`; require exit 0. Commit with message file `feat: filter traces by agent name and typed tags`.

## Task 5: Document, verify, and review the complete behavior

**Files:** Documentation row above; affected tests only if verification identifies a gap.

- [ ] Update the developer docs with `setTags`, key merging, file-order precedence, legacy label interpretation, config-to-wire encoding, and the automatic family tag. Explain configuration re-emission on interrupt resume and subprocess start/resume, including the spec's `"website"` to `"configured"` example and the subprocess inheritance exceptions. Clarify trace scope and the distinction from `std::tag`. Examples must use valid Agency syntax. Do not edit `docs/site/guide/`; mention any guide follow-up once in a future PR description.
- [ ] In `docs/dev/hosting/statelog.md`, explain that primitive redaction matches by value in the emitting logger's tag store, affecting subsequent serialization but not earlier entries. Document replacement strings as ordinary saved filter values; do not promise immediate sibling or cross-process redaction propagation.
- [ ] In `docs/dev/cli/logs-viewer.md`, explain the trace picker versus Overview, context-specific `F`, typing-safe `I`, and persistence of both text query and metadata filters across navigation and follow updates.
- [ ] Verify a synthetic mixed log in the terminal at 100 and 180 columns. Exercise names, booleans versus strings, a missing tag, a long value, a later update, and no matches. Use `/Users/adityabhargava/agency-lang/packages/agency-lang/log.oct26.jsonl` read-only for the large-log check; it lives in the main checkout, outside this worktree. The named coordinator traces must be selectable without matching prompt mentions. Do not copy the log into fixtures or commits.
- [ ] Run `pnpm exec prettier --write` with explicit changed TypeScript paths, saving output to `/tmp/statelog-tag-task-5-format.log`. Run `pnpm run fmt:ts:check > /tmp/statelog-tag-format-check.log 2>&1`, `pnpm run typecheck > /tmp/statelog-tag-task-5-types.log 2>&1`, and `pnpm run lint:structure > /tmp/statelog-tag-lint.log 2>&1`; each must exit 0. Run `make` again only if subsequent stdlib/source changes require it.
- [ ] Run the focused unit group covering Tasks 1–4 once after the final changes, saving output to `/tmp/statelog-tag-final-tests.log`. Repeat the targeted Agency-JS fixture only if later changes affect it. Do not run the full Agency test suite.
- [ ] Review against `docs/dev/contributing/anti-patterns.md`: one metadata policy, the shared name accessor, declarative columns/filters/key tables, one session edit operation, and one matching result. Check that consumers do not read wire fields, mutate shared selection, duplicate width allocation, or reach into cursor/scroll internals. Keep public fields limited to actual consumers. Request independent final code review and address actionable findings.
- [ ] Commit documentation/verification fixes with message files. A later instruction to publish should use a concrete PR description in a file, normal push, and attach the resulting PR. This planning request does not itself create a PR.

## Plan review checklist

- [x] The public name is `setTags` and the key/value semantics match the example.
- [x] Configured tags, setter patches, legacy logs, and reader ordering have one documented contract.
- [x] Every run still has one primary list row and full metadata remains accessible.
- [x] Filters use declarative predicates and persist across session navigation.
- [x] Every Review Focus item has a concrete test in its owning task.
