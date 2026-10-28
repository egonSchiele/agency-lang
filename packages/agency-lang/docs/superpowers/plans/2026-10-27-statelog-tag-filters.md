# Agent Names in the Trace Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each trace's recorded agent name in the logs viewer's trace picker, and let an `agent:` prefix in the picker's search keep only traces whose name starts with the typed text.

**Architecture:** Record the name on the trace root while `buildForest` walks events in file order. Copy it onto `TraceSummary`. The picker adds one fixed-width column and parses an `agent:` prefix out of its query into a second `TraceFilter`, which runs through the existing `applyFilters`. No new events, screens, keys, or stdlib functions.

**Tech Stack:** TypeScript, the existing `lib/tui` table, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-statelog-tag-filters-design.md` (same worktree). This plan supersedes the earlier five-task plan with the same file name; the review that led to the cut is `2026-10-27-statelog-tag-filters-review-2.md` beside this file.

## Background: how the picker works today

Read this before the tasks. It is everything an executor needs to know about the code being changed.

**From file to tree.** `agency logs file.jsonl` parses every line into an `EventEnvelope` (`lib/logsViewer/types.ts`). `buildForest` in `lib/logsViewer/tree.ts` turns those events into one `TreeNode` per trace, with spans and event leaves under it. Pass 2 of `buildForest` (`tree.ts:146-161`) visits events in file order and attaches each as a leaf. Pass 4 then sorts every node's children by timestamp, so after `buildForest` returns, walking the tree no longer gives file order. `walkNodes` in `forest.ts` is also a stack walk and visits children in reverse. That is why the name must be captured in pass 2, not read back from the tree later.

**From tree to picker row.** `traceSummaries` in `lib/logsViewer/traceSummaries.ts` makes one `TraceSummary` per trace root: start time, duration, rounds, tokens, cost, the first ask, an annotation, and whether an error occurred. The picker (`lib/logsViewer/screens/tracePicker.ts`) renders those summaries as rows of a `TableComponent` (`lib/tui/table.ts`). The columns are declared as data in `columns()` (`tracePicker.ts:259-316`): a fixed width per column, a header, and a cell function. The `what` column is `"flex"` and takes whatever width is left. The table clips long cells with an ellipsis and escapes style tags in cell text (the existing test "an ask that looks like a style tag is drawn as written" covers this).

**Search and filters.** Pressing `/` puts the picker in editing mode, and each typed character is appended to `this.query`. `shown()` (`tracePicker.ts:180-186`) computes which traces are listed: it runs `searchTraces` over `traceTexts` (every string in every event) to get hits, builds a `textFilter` from those hits, and passes `[textFilter, ...this.extraFilters]` to `applyFilters` (`traceSearch.ts:58-60`), which keeps a summary only if every filter accepts it. `extraFilters` is an existing, currently empty slot. A `TraceFilter` is `{ id, label, accepts(summary) }`. When the query is non-empty the picker shows a `hits` column, a "N of M match" count, and a "first hit" snippet line. Enter on a row returns `{ kind: "selectTrace", traceId, query }` and the shell opens the trace screen with that query applied as a row search.

**Where agent names come from.** `setAgentName` in `std::statelog` posts an event `{ type: "agentName", name }` (`lib/statelogClient.ts:1046-1051`). The Agency agent calls it at startup. Two readers already pick the name out of a trace with the same rule, last valid string in file order: `lastAgentName` in `lib/eval/extract.ts:126-131` and the runs explorer in `lib/runsExplorer/mine.ts:168`.

**Tests.** `lib/logsViewer/traceFixture.ts` builds a small synthetic trace with `traceEvents(traceId, { answer, toolOutput, ask? })`. Picker tests render through `renderOf` and read the frame as text. One snapshot test renders the searched picker at 120 columns; its forest has no agent names, so the new column must stay hidden there and the snapshot must not change.

## Global Constraints

- Change only `lib/logsViewer/**` and `docs/dev/cli/logs-viewer.md`. No stdlib, runtime, config, or statelog client changes.
- No new event types or fields. The name comes from the existing `agentName` event.
- The Agent column appears only when at least one trace in the file has a name.
- Name matching is a case-sensitive prefix match on the recorded name. A trace with no name never matches.
- The `agent:` prefix is recognised only at the start of the query. The name prefix ends at the first space.
- Hits, the snippet, and the query carried into the trace screen come from the text part only.
- The column is between `Started (local)` and `duration`, width `min(26, longest name + 1)`.
- Use types, objects, and arrays; no interfaces, Maps, or Sets.
- Format only the files you changed: `npx prettier --write <files>`. Never run `pnpm run fmt:ts` from this worktree; its glob reaches sibling worktrees.
- Run `pnpm run typecheck` after every task, before its commit. Save every test and typecheck run to a file under `/tmp/`.
- Commit with a message file: `git commit -F /tmp/msg.txt`. Never amend or force push.
- Rebase the branch onto current `main` before Task 1. The branch forks from `b77f92377`, before PR #1289.

## Review Focus

1. A trace that renames itself (two `agentName` events) must show the later name, even when the later event has an earlier timestamp. Task 1 pins this.
2. A log with no names must render exactly as today, including the 120-column snapshot. Task 3 pins this.
3. A 200-character name must not push the `what` column off screen. Task 3 pins the clip.
4. `agent:` with nothing after it must list every named trace, not zero traces. Task 2 pins this.
5. Pressing Enter after `/agent:x hello` must carry `hello`, not `agent:x hello`, into the trace screen. Task 3 pins this.

---

### Task 1: Record the agent name on the trace root

**Files:**
- Modify: `lib/logsViewer/types.ts:10-36` (`TreeNode`)
- Modify: `lib/logsViewer/tree.ts:146-161` (pass 2 of `buildForest`)
- Modify: `lib/logsViewer/traceSummaries.ts`
- Modify: `lib/logsViewer/traceFixture.ts`
- Test: `lib/logsViewer/tree.test.ts`, `lib/logsViewer/traceSummaries.test.ts`

**Interfaces:**
- Produces: `TreeNode.agentName?: string`, set only on `nodeKind: "trace"` roots. `TraceSummary.agentName?: string`. `TraceContents.agentName?: string` in the fixture, which emits one `agentName` event after `agentStart` when given.

- [ ] **Step 1: Extend the fixture**

In `traceFixture.ts`, add `agentName?: string` to `TraceContents`. When set, insert `{ type: "agentName", name: contents.agentName }` into `data` directly after the `agentStart` entry, so it gets the next timestamp in sequence.

- [ ] **Step 2: Write the failing tree tests**

In `tree.test.ts`:

```ts
it("records the last agentName event on the trace root, in file order", () => {
  const events = traceEvents("A", { answer: "hi", toolOutput: "out", agentName: "first" });
  // A later event in the file with an EARLIER timestamp still wins: file order, not time.
  events.push({
    ...events[1],
    data: { type: "agentName", name: "second", timestamp: new Date(0).toISOString() },
  });
  expect(buildForest(events)[0].agentName).toBe("second");
});

it("ignores an agentName event whose name is not a string", () => {
  const events = traceEvents("A", { answer: "hi", toolOutput: "out", agentName: "kept" });
  events.push({ ...events[1], data: { type: "agentName", name: 7, timestamp: new Date(9000).toISOString() } });
  expect(buildForest(events)[0].agentName).toBe("kept");
});

it("a trace with no agentName event has no name", () => {
  expect(buildForest(traceEvents("A", { answer: "hi", toolOutput: "out" }))[0].agentName).toBeUndefined();
});
```

- [ ] **Step 3: Write the failing summary test**

In `traceSummaries.test.ts`:

```ts
it("carries the trace root's agent name", () => {
  const roots = buildForest(traceEvents("A", { answer: "hi", toolOutput: "out", agentName: "agency-agent/coordinator" }));
  expect(traceSummaries(roots, {})[0].agentName).toBe("agency-agent/coordinator");
});
```

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `pnpm test:run lib/logsViewer/tree.test.ts lib/logsViewer/traceSummaries.test.ts > /tmp/picker-agent-1-red.log 2>&1`
Expected: the four new tests fail; the existing ones pass.

- [ ] **Step 5: Implement**

In `types.ts`, add to `TreeNode`, with a comment saying it is set on trace roots only:

```ts
agentName?: string;
```

In `tree.ts` pass 2, inside the `for (const evt of events)` loop and before the `HIDDEN_EVENT_TYPES` check, when `evt.data.type === "agentName"` and `typeof evt.data.name === "string"`, set `traces[evt.trace_id].agentName = evt.data.name`. Later events overwrite earlier ones, which gives last-in-file-order for free.

In `traceSummaries.ts`, add `agentName?: string` to `TraceSummary` and set `agentName: root.agentName` in `summarize`.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm test:run lib/logsViewer/tree.test.ts lib/logsViewer/traceSummaries.test.ts > /tmp/picker-agent-1.log 2>&1`
Expected: exit 0.

- [ ] **Step 7: Typecheck, format, commit**

Run: `pnpm run typecheck > /tmp/picker-agent-1-types.log 2>&1` (exit 0), then `npx prettier --write` on the five changed files.

```bash
git add lib/logsViewer/types.ts lib/logsViewer/tree.ts lib/logsViewer/traceSummaries.ts lib/logsViewer/traceFixture.ts lib/logsViewer/tree.test.ts lib/logsViewer/traceSummaries.test.ts
git commit -F /tmp/msg.txt   # "feat: record each trace's agent name on its summary"
```

---

### Task 2: Parse the `agent:` prefix and build its filter

**Files:**
- Modify: `lib/logsViewer/traceSearch.ts`
- Test: `lib/logsViewer/traceSearch.test.ts`

**Interfaces:**
- Consumes: `TraceSummary.agentName` from Task 1.
- Produces, exported from `traceSearch.ts`:

```ts
export type PickerQuery = { agentPrefix: string | undefined; text: string };
/** Splits "agent:NAME rest" into its two parts. Any other query is all text. */
export function parsePickerQuery(query: string): PickerQuery;
/** Keeps traces whose recorded name starts with `prefix`. Unnamed traces never pass. */
export function agentFilter(prefix: string): TraceFilter;
```

`parsePickerQuery` rules, from the spec: if `query` starts with `agent:`, `agentPrefix` is the text after `agent:` up to the first space (or the end), and `text` is everything after that first space (or `""`). Otherwise `agentPrefix` is `undefined` and `text` is the whole query. `agentFilter` returns `{ id: "agent", label: \`agent:${prefix}\`, accepts }`.

- [ ] **Step 1: Write the failing tests**

Add a `describe("parsePickerQuery")` and a `describe("agentFilter")` to `traceSearch.test.ts`:

```ts
it("a plain query is all text", () => {
  expect(parsePickerQuery("hello world")).toEqual({ agentPrefix: undefined, text: "hello world" });
});
it("agent: alone is an empty prefix and no text", () => {
  expect(parsePickerQuery("agent:")).toEqual({ agentPrefix: "", text: "" });
});
it("the prefix ends at the first space and the rest is text", () => {
  expect(parsePickerQuery("agent:agency-agent/ time out")).toEqual({ agentPrefix: "agency-agent/", text: "time out" });
});
it("agent: in the middle of a query is just text", () => {
  expect(parsePickerQuery("see agent:x")).toEqual({ agentPrefix: undefined, text: "see agent:x" });
});

// agentFilter, over summaries built with traceEvents(..., { agentName }):
it("keeps names that start with the prefix, case-sensitively, and drops unnamed traces", () => {
  // A: "agency-agent/coordinator", B: "Agency-agent/x", C: no name
  const kept = applyFilters(summaries, [agentFilter("agency-agent/")]).map((s) => s.traceId);
  expect(kept).toEqual(["A"]);
});
it("an empty prefix keeps every named trace", () => {
  expect(applyFilters(summaries, [agentFilter("")]).map((s) => s.traceId)).toEqual(["A", "B"]);
});
it("a name mentioned only in a prompt does not count", () => {
  // D: no name, ask "run agency-agent/coordinator please"
  expect(applyFilters([summaryD], [agentFilter("agency-agent")])).toEqual([]);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test:run lib/logsViewer/traceSearch.test.ts > /tmp/picker-agent-2-red.log 2>&1`
Expected: the new tests fail because the exports do not exist.

- [ ] **Step 3: Implement `parsePickerQuery` and `agentFilter` in `traceSearch.ts`**

Pure functions, no state. `accepts` is `summary.agentName !== undefined && summary.agentName.startsWith(prefix)`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test:run lib/logsViewer/traceSearch.test.ts > /tmp/picker-agent-2.log 2>&1`
Expected: exit 0.

- [ ] **Step 5: Typecheck, format, commit**

Run: `pnpm run typecheck > /tmp/picker-agent-2-types.log 2>&1` (exit 0), `npx prettier --write lib/logsViewer/traceSearch.ts lib/logsViewer/traceSearch.test.ts`.

```bash
git add lib/logsViewer/traceSearch.ts lib/logsViewer/traceSearch.test.ts
git commit -F /tmp/msg.txt   # "feat: parse an agent: prefix out of the picker query"
```

---

### Task 3: Show the column and apply the filter in the picker

**Files:**
- Modify: `lib/logsViewer/screens/tracePicker.ts` (`LAYOUT`, `shown()`, `openSelected()`, `render()`, `columns()`)
- Test: `lib/logsViewer/screens/tracePicker.test.ts`

**Interfaces:**
- Consumes: `parsePickerQuery`, `agentFilter` (Task 2); `TraceSummary.agentName` (Task 1); fixture `agentName` (Task 1).
- Produces: no new exports. `ShownTraces` gains `text: string` (the text part) so `render()` and `columns()` can decide hits visibility from it.

- [ ] **Step 1: Write the failing picker tests**

Add a helper to the test file:

```ts
function namedForest(): TreeNode[] {
  return buildForest([
    ...traceEvents("A", { answer: "ok", toolOutput: "done", agentName: "agency-agent/coordinator" }),
    ...traceEvents("B", { answer: "ok", toolOutput: "done", agentName: "agency-agent/explorer" }),
    ...traceEvents("C", { answer: "agency-agent/coordinator", toolOutput: "done" }),
  ]);
}
```

Then:

```ts
it("shows an agent column only when some trace has a name", () => {
  expect(renderPicker(threeTraceForest())).not.toMatch(/\bagent\s+duration/);   // header absent
  const text = renderPicker(namedForest());
  expect(text).toMatch(/Started \(local\)\s+agent\s+duration/);
  expect(text).toContain("agency-agent/coordinator");
});

it("clips a long name so the ask column stays on screen", () => {
  const roots = buildForest(traceEvents("A", { answer: "ok", toolOutput: "done", agentName: "a".repeat(200) }));
  const text = renderOf(new TracePicker(roots, { currentTraceId: "A", annotations: {}, thresholds: DEFAULT_THRESHOLDS }));
  expect(text).toContain("ask for A");
  expect(text).not.toContain("a".repeat(30));
});

it("agent: keeps only traces whose recorded name starts with the prefix", () => {
  const picker = makePicker(namedForest());
  press(picker, "/");
  type(picker, "agent:agency-agent/c");
  const text = renderOf(picker);
  expect(text).toContain("1 of 3 match");
  expect(text).toContain("ask for A");
  expect(text).not.toContain("ask for C");   // C only mentions the name in its answer
  expect(text).not.toContain("hits");        // no text part, so no hits column
});

it("agent: with nothing after it lists every named trace", () => {
  const picker = makePicker(namedForest());
  press(picker, "/");
  type(picker, "agent:");
  expect(renderOf(picker)).toContain("2 of 3 match");
});

it("text after the agent prefix searches the matching traces and is carried into the trace", () => {
  const picker = makePicker(namedForest());
  press(picker, "/");
  type(picker, "agent:agency-agent/ ask for B");
  expect(renderOf(picker)).toContain("1 of 3 match");
  expect(renderOf(picker)).toContain("hits");
  press(picker, "Enter");
  expect(press(picker, "Enter")).toEqual({ kind: "selectTrace", traceId: "B", query: "ask for B" });
});

it("Enter after an agent-only query carries no text query", () => {
  const picker = makePicker(namedForest());
  press(picker, "/");
  type(picker, "agent:agency-agent/e");
  press(picker, "Enter");
  expect(press(picker, "Enter")).toEqual({ kind: "selectTrace", traceId: "B" });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test:run lib/logsViewer/screens/tracePicker.test.ts > /tmp/picker-agent-3-red.log 2>&1`
Expected: the six new tests fail; all existing tests, including the 120-column snapshot, pass.

- [ ] **Step 3: Implement in `tracePicker.ts`**

- Add `agentMaxWidth: 26` to `LAYOUT`.
- Change `ShownTraces` to `{ summaries; hits; searching; text: string }`.
- In `shown()`: `const { agentPrefix, text } = parsePickerQuery(this.query)`. Hits come from `searchTraces(this.texts, text)`. Filters are, in order: `textFilter(text, hits)` only when `text.length > 0`, `agentFilter(agentPrefix)` only when `agentPrefix !== undefined`, then `...this.extraFilters`. `searching` stays `this.query.length > 0`.
- In `openSelected()`: carry `query: text` only when `text.length > 0`, otherwise omit it. Get `text` from `parsePickerQuery(this.query)`.
- In `columns()`: push the `hits` column only when `shown.text.length > 0`. After the `started` column, when `this.summaries.some((s) => s.agentName !== undefined)`, push:

```ts
{
  key: "agent",
  header: "agent",
  width: Math.min(LAYOUT.agentMaxWidth, 1 + Math.max(...this.summaries.map((s) => s.agentName?.length ?? 0))),
  cell: (summary) => summary.agentName ?? "",
}
```

The width test uses all summaries, not only the shown ones, so the column does not jump as the user types. The `first hit` line in `render()` already reads `shown.hits`, which is empty with no text part, so it needs no change.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm test:run lib/logsViewer/screens/tracePicker.test.ts lib/logsViewer/run.shell.test.ts > /tmp/picker-agent-3.log 2>&1`
Expected: exit 0, and no snapshot was rewritten (`git status` shows no change under `__snapshots__`).

- [ ] **Step 5: Look at it once with the real log**

Run: `pnpm run agency logs /Users/adityabhargava/agency-lang/packages/agency-lang/log.oct26.jsonl` if that file still exists (it is untracked in the main checkout; do not copy it into the worktree). Press `t` if the picker is not already open, confirm the `agent` column shows `agency-agent/coordinator` on the agent's rows, type `/agent:agency-agent/`, and confirm the match count drops to the named traces. Quit with `q`. This is a look, not a test; note anything odd in the commit message.

- [ ] **Step 6: Typecheck, format, commit**

Run: `pnpm run typecheck > /tmp/picker-agent-3-types.log 2>&1` (exit 0), `npx prettier --write lib/logsViewer/screens/tracePicker.ts lib/logsViewer/screens/tracePicker.test.ts`.

```bash
git add lib/logsViewer/screens/tracePicker.ts lib/logsViewer/screens/tracePicker.test.ts
git commit -F /tmp/msg.txt   # "feat: show agent names in the trace picker and filter on them with agent:"
```

---

### Task 4: Document the column and the prefix

**Files:**
- Modify: `docs/dev/cli/logs-viewer.md:75-87` (the trace picker section)

- [ ] **Step 1: Update the picker section**

Add two short paragraphs after the one that begins "A `TraceFilter` declares an ID, label and a predicate" (line 83):

- One on the Agent column: where the name comes from (the last `agentName` event in file order, recorded on the trace root in pass 2 of `buildForest` because later passes reorder the tree), when the column is shown, its width cap, and that the same rule is used by `eval extract` and the runs explorer.
- One on the `agent:` prefix: the grammar (start of query, prefix to the first space, the rest is text), prefix matching and why (narrows as you type, selects a family), that hits and the carried query come from the text part only, and that `parsePickerQuery` and `agentFilter` in `traceSearch.ts` own this.

Also extend the first sentence of the section (line 77), which lists the picker's columns, to include the agent name.

Write in plain sentences. No history, no test narration.

- [ ] **Step 2: Final checks**

Run, saving each to `/tmp/`: `pnpm run typecheck`, `pnpm run lint:structure`, `npx prettier --check` on every `.ts` file changed in Tasks 1 to 3, and `pnpm test:run lib/logsViewer/tree.test.ts lib/logsViewer/traceSummaries.test.ts lib/logsViewer/traceSearch.test.ts lib/logsViewer/screens/tracePicker.test.ts lib/logsViewer/run.shell.test.ts`. All exit 0. Run `git diff --check`.

- [ ] **Step 3: Commit**

```bash
git add docs/dev/cli/logs-viewer.md
git commit -F /tmp/msg.txt   # "docs: describe the picker's agent column and agent: search prefix"
```

Then push the branch and open the PR. The PR body should say what the user sees (the column and the prefix), name the two prior review files as the reason the scope is this small, and leave the owner to merge.
