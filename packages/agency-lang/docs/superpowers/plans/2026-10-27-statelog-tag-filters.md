# StateLog Tag Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find complete traces by their recorded agent name and string key/value tags, keeping the trace picker compact.

**Architecture:** Reuse `runMetadata.custom`. A writer-owned `customSource` marker distinguishes defaults from explicit updates; one pure reader resolves explicit values over defaults in file order. Extend existing `TraceFilter`, `TableComponent`, `DetailScreen`, keybindings, and view actions.

**Tech Stack:** Agency, TypeScript, existing TUI components, Vitest, deterministic Agency-JS fixtures. No new dependencies.

**Spec:** [Agent names and run tags in the logs viewer](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/docs/superpowers/specs/2026-10-27-statelog-tag-filters-design.md). Read it together with the [existing-capabilities review](/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/statelog-tag-filters/packages/agency-lang/docs/superpowers/plans/2026-10-27-statelog-tag-filters-existing-capabilities-review.md); this spec resolves the review's precedence question.

## Global constraints

- Work in the existing `codex/statelog-tag-filters` worktree. This document is the requested deliverable; implementation requires a subsequent instruction.
- Reuse `custom: Record<string, string>`. Preserve `tags: string[]` separately. Add no `tagValues`, scalar widening, legacy boolean conversion, or configuration schema changes.
- Explicit keys override defaults regardless of later resume/subprocess emissions. Later updates within the same class replace supplied keys; omitted keys remain.
- Write `customSource: "defaults" | "explicit"` only as event context. Unmarked historical custom records are defaults; unknown markers contribute no custom update.
- Preserve the custom dictionary's identity until normal redaction. Protect only the metadata event's reserved type/source literals from redaction.
- Keep names last-valid-string per trace. No root-name field, automatic family tags, or new eval/Explorer fields.
- Keep one primary picker row per trace; Overview is unchanged. Reuse existing rendering and filtering components.
- Preserve current text-query reopening and all-trace `<`/`>` behavior. Applied metadata selection persists.
- No checkpoint, handler, runtime tag-store, IPC, or value-tag changes. No hosted-server compatibility claim beyond the inspected client paths.
- Use types, objects, arrays, and static imports. Add no dependencies or symlink support.
- Generate stdlib documentation from source comments through `make`. Edit developer docs, not user-facing guides or generated source directly.
- Save verification output. Run focused tests and deterministic fixtures, not the full Agency suite or paid model calls.
- Format only changed TypeScript paths before each task's typecheck. Use a commit-message file and `git commit -F`; never amend or force push.

## Review focus

1. Resume and subprocess starts must not reset explicit values, including `""`. Tasks 1 and 2 pin this.
2. Value redaction must not erase or promote the source marker, and whole-object redaction must remain effective. Tasks 1 and 2 pin this.
3. Historical, malformed, interleaved, and misleading-timestamp events must resolve deterministically. Tasks 1 and 3 pin this.
4. Long names, tags, and active text search must fit a 100-column picker without extra rows. Task 3 pins this.
5. Nested details, canceled drafts, follow refresh, typing, and zero matches must keep the correct trace and filter state. Tasks 3 and 4 pin this.

## Existing capabilities and file responsibilities

| Area | Files | Change |
| --- | --- | --- |
| Event contract and reader | New `lib/statelog/runMetadata.ts`, `.test.ts`; `lib/statelogClient.ts`, its tests and redaction tests; `eslint.config.js` | Validate string dictionaries, mark origin, derive effective trace metadata, and register the browser-safe module |
| Agency setter | `stdlib/statelog.agency`, `lib/stdlib/statelog.ts`, `.test.ts` | Thin setter through the current logger |
| Integration | New `tests/agency-js/set-statelog-tags/{agent.agency,test.js,fixture.json,agency.json}`; existing config/codegen/IPC tests | Prove existing custom forwarding and new precedence through actual execution |
| Reader integration | `lib/logsViewer/{types,tree,traceSummaries,summary}.ts`, their tests | Attach metadata computed before tree reordering |
| Display | `screens/tracePicker.ts`, `views/detailScreen.ts`, `detailTarget.ts`, `screens/chrome.ts`, `run.ts`, matching tests | Compact columns and existing detail view for metadata |
| Metadata filters | New `lib/logsViewer/traceFilters.ts`, `views/traceFiltersView.ts`, matching tests; existing `traceSearch.ts` | Convert selections to existing predicates and provide a small draft editor |
| Session integration | `views/view.ts`, `run.ts`, `run.shell.test.ts` | Applied selection, view actions, keyboard dispatch, focus |
| Documentation | `docs/dev/hosting/statelog.md`, `docs/dev/runtime/config.md`, `docs/dev/cli/logs-viewer.md` | Storage, precedence, API scope, and controls |

No production changes are expected in the config schema, compiler encoding, IPC, eval extractor, Runs Explorer, or `std::tag`. Tests should verify reuse rather than add adapters for those paths.

## Declarative boundaries

| Caller supplies | Boundary owns |
| --- | --- |
| A dictionary and source | Metadata writer owns reserved fields and normal emission |
| Ordered envelopes | Pure metadata reader owns validation, per-key precedence, and name extraction |
| Applied selection | Predicate builder returns existing `TraceFilter` records |
| Column definitions | Existing table owns measurement, clipping, and painting |
| A detail target | Existing detail screen resolves and renders row or trace metadata |
| Apply/cancel action | Session commits selection; overlay owns only a draft |

Keep source classification and merging in the metadata reader. Consumers receive effective tags, never mutable default/explicit dictionaries. Do not add a second filter engine, layout engine, payload painter, or configurable serialization framework.

## Execution preflight

- [ ] Read the spec, review, package instructions, and the four contributing guides. Preserve the user's untracked `2026-10-27-statelog-tag-filters-review.md`.
- [ ] Before the lifecycle fixture, read the interrupt lifecycle instructions and `docs/site/guide/{interrupts,handlers,effects,policies}.md`, plus `docs/dev/runtime/{interrupts,checkpointing,subprocess-ipc}.md`. Use public resume APIs and normal handlers.
- [ ] Install worktree dependencies only if absent: `pnpm install --frozen-lockfile > /tmp/statelog-tags-install.log 2>&1` from the worktree repository root. Require exit 0; do not alter the lockfile.
- [ ] Run a focused baseline once, saving output: `pnpm test:run lib/statelogClient.test.ts lib/stdlib/statelog.test.ts lib/logsViewer/traceSearch.test.ts lib/logsViewer/screens/tracePicker.test.ts > /tmp/statelog-tags-baseline.log 2>&1`. Resolve existing failures before feature work. The prior audit passed 167 focused tests at the same code base; that is historical evidence, not feature validation.

## Task 1: Define source-aware custom metadata and its reader

**Files:** New `lib/statelog/runMetadata.ts`, `.test.ts`; `lib/statelogClient.ts`, `.test.ts`, `.redaction.test.ts`; `eslint.config.js`.

**Interfaces produced:**

```ts
type RunTags = Record<string, string>;
type CustomSource = "defaults" | "explicit";
type TraceMetadata = { agentName?: string; tags: RunTags };

validateRunTags(value: unknown): RunTags;
isCustomSource(value: unknown): value is CustomSource;
traceMetadataById(events: readonly EventEnvelope[]): Record<string, TraceMetadata>;

// Existing StatelogClient method gains an optional second argument:
runMetadata(
  metadata: RunMetadata & { moduleName?: string; entryNode?: string },
  customSource?: CustomSource,
): Promise<void>;
```

Default the writer's second argument to `"defaults"`. Keep the two accumulation dictionaries private to `runMetadata.ts`; callers only receive effective metadata. The reader visits the supplied envelopes once in input order and returns independent entries per trace.

- [ ] Add failing reader tests: defaults `{project:"configured",region:"east"}`, explicit `{project:"website"}`, then defaults `{project:"resumed",region:"west"}` yield `{project:"website",region:"west"}`. Later explicit `{project:"review"}` wins. Explicit `""` stays explicit. Omitted keys survive and independent traces never share values.
- [ ] Add historical/malformed tests: absent source means defaults; unknown/null source is ignored; non-record custom is ignored; valid string siblings survive invalid entries; legacy labels are not converted; valid names retain last-string behavior. Interleave sibling spans and reverse timestamps to prove file order.
- [ ] Add validator tests for original-object identity, empty patch, empty key/value, null-prototype records, own `constructor`/`prototype`, and atomic rejection of `__proto__`, arrays, null, nested values, numbers, booleans, and undefined. Saved malformed data is tolerated as the spec defines; writer input is strict.
- [ ] Run new tests and confirm failures for missing behavior; save output to `/tmp/statelog-tags-1-red.log`.
- [ ] Implement the pure reader and validator. Use safe own-property operations for trace IDs and tag keys. Do not walk the rendered span tree or infer origin from `entryNode`.
- [ ] Add `lib/statelog/runMetadata.ts` to `BROWSER_FILES` in `eslint.config.js`, because the logger imports its runtime predicate. Keep the module free of Node dependencies and import envelope types with `import type`.
- [ ] Extend `runMetadata` to write `{ ...metadata, type: "runMetadata", customSource }`. Existing `agentStart` uses the default source. Assert injected top-level type/source cannot replace these fields, while nested custom keys with those names remain user data.
- [ ] In `post()`, after normal redaction, restore only `type` and `customSource` for an original metadata body with a recognized source. Reuse `isCustomSource`; do not exempt custom values or extend generic post options.
- [ ] Test real sink bytes for default/explicit markers, unchanged custom identity, whole-dictionary redaction, and `redact("explicit")`, `redact("runMetadata")`, and `redact("defaults", "explicit")`. The source/type remain correct; identical strings inside custom still redact. Feed saved envelopes into the reader and assert defaults never become explicit.
- [ ] Run `pnpm test:run lib/statelog/runMetadata.test.ts lib/statelogClient.test.ts lib/statelogClient.redaction.test.ts > /tmp/statelog-tags-1.log 2>&1`; require exit 0. Format changed TypeScript files, run `pnpm run typecheck > /tmp/statelog-tags-1-types.log 2>&1` and `node scripts/lint-browser-reach.mjs > /tmp/statelog-tags-1-browser.log 2>&1`; require exit 0.
- [ ] Commit with message file: `feat: distinguish default and explicit custom run metadata`.

## Task 2: Add the Agency setter and verify lifecycle precedence

**Files:** `stdlib/statelog.agency`, `lib/stdlib/statelog.ts`, `.test.ts`; new fixture directory above; `lib/config/config.test.ts`, `lib/backends/statelog.codegen.test.ts`, `lib/runtime/ipc.test.ts` only for focused coverage.

**Consumes:** Task 1's `RunTags`, validator, writer, and `traceMetadataById`.

**Produces:**

```agency
export def setTags(tags: Record<string, string>) {
  _setRunTags(tags)
}
```

The private TypeScript helper is `_setRunTags(tags: RunTags): Promise<void>`. It validates first, returns for an empty patch or absent frame, and otherwise calls `frame.log.runMetadata({ custom: tags }, "explicit")`, retaining the exact dictionary reference.

- [ ] Add failing unit tests: current branch logger receives custom plus explicit source; valid frameless calls emit nothing; invalid frameless calls throw; empty patches emit nothing; validation failure emits no partial event.
- [ ] Run them and save the expected failures to `/tmp/statelog-tags-2-red.log`.
- [ ] Implement the wrapper and its source docstrings. Explain string values, patching, defaults, trace scope, logging prerequisites, the separate value-tag API, and import aliasing. No new runtime state.
- [ ] Add direct config/codegen tests showing the existing `log.metadata.custom` record survives unchanged. Pin current `__proto__` stripping. Extend IPC tests with custom defaults and its existing explicit-child-log-file/disabled-observability exceptions, without changing forwarding code.
- [ ] Add the deterministic Agency-JS fixture using `set-agent-name` for logging and `subprocess-pause-basic` for the subprocess handler. Consult `subprocess-statelog-runid` for resume assertions, but do not copy its explicit child `logFile` argument because that bypasses inheritance. Enable parent observability and a file sink, configure `custom: {project:"configured", region:"east"}`, and keep legacy `tags:["interactive"]`.
- [ ] In one case, set `{project:"website", owner:"parent"}`, then raise a deterministic interrupt. The JS harness uses the public `respondToInterrupts` API. Assert one trace ID, repeated default emissions, exactly one setter event, preserved handler behavior, expected ordinary return value, and effective `project="website"` before and after resume.
- [ ] In another case, launch a real subprocess on the inherited sink after the parent setter. Omit the child's `logFile` argument. Assert its startup defaults leave `project="website"`. Have the child explicitly set `{owner:"child"}`; assert it overrides only that explicit key. Then raise a deterministic child interrupt and resume through the public API. Assert the parent and child resume defaults preserve both explicit keys. Approve only `std::run` in the parent handler and allow the child's interrupt to reach the caller.
- [ ] The fixture's JS harness should parse the saved file with the production parser and reader. Include a redacted string and a whole redacted custom dictionary through the public setter. Assert the final file and effective tags, not a mock call alone.
- [ ] Run `pnpm test:run lib/stdlib/statelog.test.ts lib/config/config.test.ts lib/backends/statelog.codegen.test.ts lib/runtime/ipc.test.ts > /tmp/statelog-tags-2.log 2>&1`. Run `make > /tmp/statelog-tags-2-build.log 2>&1`, then `pnpm run agency test js tests/agency-js/set-statelog-tags > /tmp/statelog-tags-2-agency-js.log 2>&1`. Require exit 0 for each.
- [ ] Review generated output, format changed TypeScript files, run `pnpm run typecheck > /tmp/statelog-tags-2-types.log 2>&1`, and commit with message file `feat: expose explicit StateLog run tags`.

## Task 3: Add compact metadata display using the existing detail view

**Files:** `lib/logsViewer/{types,tree,traceSummaries,summary,detailTarget}.ts`; `screens/{tracePicker,chrome}.ts`; `views/{detailScreen,view}.ts`; `run.ts`; related tests.

**Consumes:** `traceMetadataById` and `TraceMetadata`.

**Produces:**
- Optional `TreeNode.traceMetadata: TraceMetadata` on trace roots, plus `TraceSummary.agentName?: string` and `tags: RunTags`.
- `DetailTarget = { kind: "row"; rowId: string } | { kind: "traceMetadata"; traceId: string }` in `detailTarget.ts`.
- `DetailScreen(roots, target: DetailTarget, thresholds)`, with a focus accessor returning `{traceId: string; rowId?: string} | undefined`.
- `ViewAction` gains `{ kind: "openTraceMetadata"; traceId: string }`; existing row-detail actions retain their meaning.

- [ ] Add failing tree/summary tests that compare roots against the pure reader for interleaved traces, reordered span trees, misleading timestamps, no metadata, and historical custom records.
- [ ] Call `traceMetadataById(events)` once before tree reordering and attach results to roots. This extra linear pass keeps reducer state out of tree construction. Summaries and views read effective metadata only.
- [ ] Add bounded Agent and optional Tags columns to the current picker table. Use the spec's widths and drop order. Include custom pairs in the existing event summary while retaining legacy label summaries.
- [ ] Extend `DetailScreen` with the target union. Resolve by target on every `setData`; build metadata `PayloadLine[]` and feed the existing `paintPayload`. Reuse raw JSON, copy, cache, and scroll behavior. Do not manufacture a story/event row for merged metadata.
- [ ] Update existing constructor call sites/tests to use row targets. Metadata targets expose their trace ID and no row ID. Update `focusedRow` and the header's target resolution to honor overlay origin, including a picker selection different from the open trace. Keep comment controls unavailable without a real row.
- [ ] Add `I` through the existing binding/action tables for picker selection and open trace, guarded against query typing. Include the selected agent name in the existing header. A missing target produces a stale-detail message and safe back behavior.
- [ ] Test 100-column rendering with a 200-character name, long tags, and active search. Assert no new primary-row wrapping, prompt space, Hits visibility, and access to full values through metadata detail. Test escaping ANSI/style-like input using existing safe rendering.
- [ ] Test ordinary detail/comment behavior, metadata raw/copy/scroll, follow refresh, stale targets, and opening metadata over a non-current picker trace. Verify header and session focus name that selected trace. An existing untagged trace must show its ID and an empty metadata state, not immediately close as a missing row.
- [ ] Run `pnpm test:run lib/logsViewer/tree.test.ts lib/logsViewer/traceSummaries.test.ts lib/logsViewer/summary.test.ts lib/logsViewer/screens/tracePicker.test.ts lib/logsViewer/detailTarget.test.ts lib/logsViewer/views/detailScreen.test.ts lib/logsViewer/run.shell.test.ts > /tmp/statelog-tags-3.log 2>&1`; require exit 0.
- [ ] Format changed TypeScript files, run `pnpm run typecheck > /tmp/statelog-tags-3-types.log 2>&1`, and commit with message file `feat: show run metadata in the existing log viewer`.

## Task 4: Add metadata selection through existing filters and overlays

**Files:** New `lib/logsViewer/traceFilters.ts`, `.test.ts`, `views/traceFiltersView.ts`, `.test.ts`; `screens/tracePicker.ts`, `views/view.ts`, `run.ts`, picker and shell tests.

**Interfaces produced:**

```ts
type TagCondition = { key: string; value: string };
type MetadataSelection = { agentNames: string[]; tags: TagCondition[] };
type MetadataChoice =
  | { kind: "agent"; name: string }
  | { kind: "tag"; key: string; value: string };

metadataFilters(selection: MetadataSelection): TraceFilter[];
metadataChoices(
  summaries: readonly TraceSummary[],
  selection: MetadataSelection,
): MetadataChoice[];
toggleMetadataChoice(
  selection: MetadataSelection,
  choice: MetadataChoice,
): MetadataSelection;
```

The pure functions own exact matching, stable choice ordering, and one selected value per key. Serialize structured values for stable IDs; do not concatenate unescaped key/value strings.

The filter overlay uses `viewName: "traceFilters"` and takes roots, a draft selection, and an optional originating trace ID. With zero matches, the origin is absent and the header shows no selected trace; filter controls remain available. It renders a Clear row and typed choices using the existing table and cursor/keybinding helpers.

Extend `ViewAction` with `{ kind: "openTraceFilters"; traceId?: string }` and `{ kind: "applyTraceFilters"; selection: MetadataSelection }`. Add `TracePicker.setMetadataSelection(selection: MetadataSelection): void`. Add `metadataSelection: MetadataSelection` and `onClearMetadataSelection: () => void` to `TracePickerOptions`. The session's synchronous `applyMetadataSelection(selection)` operation stores selection and updates any existing picker. Both the apply action and clear callback use it. The picker setter updates its local snapshot without calling the callback.

- [ ] Add failing predicate tests: names OR; keys AND; metadata plus text AND through existing `applyFilters`; empty selection; missing key versus empty string; exact case; own `constructor`; prompt-only name mentions excluded. Choice derivation includes selected but absent values and avoids ID collisions.
- [ ] Add failing draft tests: toggling names, replacing a value for one key, clear, Enter commit, Escape cancel, and draft isolation from applied selection.
- [ ] Run failing tests to `/tmp/statelog-tags-4-red.log`, then implement the pure functions and small filter view. Keep filter composition in `traceSearch.ts` unchanged.
- [ ] Connect picker `F` to the overlay. Apply via one shell action, close the overlay, update the picker, and retain its selected trace if still matched. Store only metadata selection in session state.
- [ ] Render match counts for metadata-only filtering as well as text search. Preserve current zero-result behavior. Keep `escape(): boolean`: clear text first; otherwise, if metadata selection is active, call `onClearMetadataSelection()` and return true; otherwise return false for existing back behavior. Do not change the shared escape protocol.
- [ ] Recompute choices on follow without discarding selected absent choices or unapplied drafts. Keep the originating trace ID for filter/header focus. Reopening the picker receives current applied metadata selection.
- [ ] Add shell tests covering apply/cancel, follow, reopen, zero matches, and clear. Type `FIX` in search and assert no overlay opens. Assert Trace-screen `F`, lowercase `f`, text-query reset on picker reconstruction, and all-trace `<`/`>` navigation remain unchanged.
- [ ] Run `pnpm test:run lib/logsViewer/traceFilters.test.ts lib/logsViewer/views/traceFiltersView.test.ts lib/logsViewer/traceSearch.test.ts lib/logsViewer/screens/tracePicker.test.ts lib/logsViewer/run.shell.test.ts > /tmp/statelog-tags-4.log 2>&1`; require exit 0.
- [ ] Format changed TypeScript files, run `pnpm run typecheck > /tmp/statelog-tags-4-types.log 2>&1`, and commit with message file `feat: filter log traces by names and custom tags`.

## Task 5: Document and verify the complete path

**Files:** Developer docs listed above; source docstrings if corrections are needed.

- [ ] Document the two source classes, historical fallback, string-only custom values, last-recorded names, no deletion, logging prerequisites, and complete-trace scope. Include the resume/subprocess example with explicit values preserved.
- [ ] Document picker controls, one-row display, metadata details, metadata filter persistence, and unchanged text-query/trace-stepping behavior. State the local-reader guarantee without claiming hosted merge support.
- [ ] Run the affected focused Vitest files once as a combined selection, save output to `/tmp/statelog-tags-final-tests.log`, and require exit 0. Re-run the deterministic fixture if source changed after Task 2.
- [ ] If stdlib changed since the last build, run `make > /tmp/statelog-tags-final-build.log 2>&1`. Run `pnpm run typecheck > /tmp/statelog-tags-final-types.log 2>&1`, `pnpm run lint:structure > /tmp/statelog-tags-final-structure.log 2>&1`, and `pnpm run fmt:ts:check > /tmp/statelog-tags-final-format.log 2>&1`. Require exit 0; report pre-existing failures separately.
- [ ] Inspect the real log read-only at `/Users/adityabhargava/agency-lang/packages/agency-lang/log.oct26.jsonl` if still present. Verify exact agent-name filtering without rewriting it. Inspect the fixture output for custom tags and precedence. Do not copy private logs into the repository.
- [ ] Check `git diff --check` and review scope against the anti-pattern catalog: one metadata reader, existing predicates/table/detail painter, no duplicate storage, and no runtime state for annotations. Commit docs with a message file.
- [ ] Request an independent review of the complete change. Report checks and any unverified hosted behavior. PR creation belongs to a later implementation instruction, not this planning task.
