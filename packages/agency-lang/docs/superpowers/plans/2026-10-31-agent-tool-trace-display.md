# Agent Tool Trace Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency agent` prints one short line per tool call that names what the tool touched and whether it worked, driven by a data table, with readable names for saved tool output.

**Architecture:** The runtime's `onToolCallEnd` hook gains the call's arguments, so a line can be built when the call settles. `TOOL_PRESENTATIONS` in `lib/stdlib/agentToolTrace.ts` gains a `summary` kind (label, a `show` function built from shared helpers, one or two lines, result summarizer) and a `silent` kind. The spill store keeps a readable `source` beside each saved output, and the readers' trace lines show it.

**Tech Stack:** TypeScript (vitest), Agency (`trace.agency`, `spill.agency`, `safeBash.agency`).

**Spec:** `docs/superpowers/specs/2026-10-31-agent-tool-trace-display-design.md`. Its per-tool table is the source of truth for every row. The review at `docs/superpowers/plans/2026-10-31-agent-tool-trace-display-REVIEW.md` is folded in here.

## Global Constraints

- Paths are relative to `packages/agency-lang`. Work in the worktree `worktree-tool-trace-display`.
- Project rules: types not interfaces, objects not maps, arrays not sets, no dynamic imports. `lib/runtime` must not import from `lib/stdlib/agentToolTrace.ts`.
- Run `pnpm run typecheck` after every TypeScript edit and `make` after editing any `.agency` file under `stdlib/` or `lib/agents/`. Run `pnpm run fmt:ts` on changed files only. Run `pnpm run lint:structure` before the last commit.
- Tests: `pnpm vitest run <file>`, output saved to a file in the scratchpad. No LLM calls in any new test. Do not run the whole agency test suite.
- Commit messages go in a file and are passed with `git commit -F <file>`. End each with the attribution line the executing session's instructions give.
- The todo, web search, and subagent displays keep their current output byte for byte, including the dim tool name in their headings. The generic display keeps the tool name too: it is that heading's only label. Only `summary` lines drop it (and show it again under `--debug`). The existing tests in `lib/stdlib/agentToolTrace.test.ts` keep passing unchanged.
- Display rules from the spec: one line for instant tools, `●` blue start and `✓`/`✗` end for two-line tools, failures in full under the line, elapsed only when at least 1000 ms and only on two-line tools, no result preview except where the table says `preview`.

## Review Focus

1. **A `show` helper reads an argument the call did not pass.** Expected: that part is skipped, the line still prints. Test in Task 3.
2. **A numeric or array argument** (`number: 1310`, `paths: ["a","b"]`). Expected: digits, space-joined, never `[object Object]`. Test in Task 3.
3. **A `safeBash` failure whose message is not the JSON shape.** Expected: the message prints in full under the line. Test in Task 4.
4. **A `readSpill` name not in the store.** Expected: the raw name prints. Test in Task 5.
5. **`onToolCallEnd` after a resume from a checkpoint.** Expected: `data.args` is the start hook's object. Test in Task 1.
6. **A nonzero exit on a plain-object result** (`exec`, `agencyCli`). Expected: red mark and output under the line, not a green check. Test in Task 4.
7. **A multi-line command.** Expected: first line plus `…`, once at start and once at end. Test in Task 3.

---

### Task 1: `onToolCallEnd` carries the call's arguments

**Files:**
- Modify: `lib/runtime/hooks.ts:53`
- Modify: `lib/runtime/prompt.ts:1686-1693`
- Modify: `tests/agency-js/block-callback-tool-resume/agent.agency`, `test.js`, `fixture.json`

**Interfaces:**
- Produces: `onToolCallEnd: { toolName: string; args: Record<string, unknown>; result: any; timeTaken: number }`. `args` is the `namedArgs` object the start hook received. `gateInputFor` rebuilds it from the saved tool call on every pass (`prompt.ts:1415-1420`), so a resumed run has it.

- [ ] **Step 1: Extend the existing resume test.** Give `interruptTool` a `name: string` parameter. In `test.js`, the scripted round-one tool call passes `{ name: "FOO" }`; the `onToolCallEnd` capture records `{ toolName, args }` into a new `toolEndArgs` array written to `__result.json`. Add to `fixture.json`: `"toolEndArgs": [{ "toolName": "interruptTool", "args": { "name": "FOO" } }, { "toolName": "noopTool", "args": {} }]`.
- [ ] **Step 2: Run** `pnpm run agency test js tests/agency-js/block-callback-tool-resume > <scratchpad>/t1.log 2>&1`. Expected: FAIL, args undefined.
- [ ] **Step 3: Implement.** Add `args` to the hook type; pass `args: namedArgs` at the end hook.
- [ ] **Step 4: Typecheck and rerun.** Expected: clean, PASS.
- [ ] **Step 5: Commit** `onToolCallEnd: pass the call's arguments`.

---

### Task 2: A readable `source` on every saved output

**Files:**
- Modify: `lib/runtime/toolOutputStore.ts`, `lib/runtime/toolInvocation.ts:215-245`, `lib/runtime/prompt.ts` (`InvokedCall` at 940, its construction at 1149, `capForLlm` calls at 694, 962, 992, 1325), `lib/stdlib/spill.ts`, `stdlib/spill.agency`, `stdlib/safeBash.agency:935-965`, `stdlib/safeBash/actions.agency:140-156`, `docs/dev/stdlib/spill.md`
- Test: `lib/runtime/toolOutputStore.test.ts`, `lib/stdlib/spill.test.ts`, `lib/runtime/prompt.test.ts` (`capToolResultForLlm` describe)

**Interfaces:**
- `type SavedOutput = { name: string; text: string; source?: string }`; `SPILL_SOURCE_CHARS = 80`; `storeOutput(run, text, source)` cuts `source` to that length; `findOutputSource(run, name): string | null`; `outputNotice(text, name, exitCode, readers, maxChars?, source?)` whose first line reads `[Output of "<source>" too long to return in full: ...]` when given a source.
- `spillSource(tool: ToolIdentity, args: Record<string, unknown>): string`: tool name, then the first string-valued argument; the name alone otherwise.
- `capToolResultForLlm(result, cap, spill, tool, args)`; `toolResultCapper(cap, spill)` returns `(result, tool, args) => ...`. `InvokedCall` gains `namedArgs`, so the rejection and error paths pass the real arguments.
- `_keepOutput(text, exitCode, source)`; Agency `keepOutput(text, exitCode, source)`. Every `safeBash` path passes `command` (the text the trace line showed): the echo arm, `runAgency` and `cliOutcome` (thread `command` down), and `runBash`.

- [ ] **Step 1: Store tests.** `keeps a readable source beside the text` (source read back; a 200-char source cut to `SPILL_SOURCE_CHARS`); `reads an entry saved without a source as having none` (reach into `run.globals` to delete the field: no public call writes that shape, and it is what an old checkpoint carries); `names the source in the notice`. Update existing `storeOutput` calls to pass a source.
- [ ] **Step 2: Spill and capper tests.** `spill.test.ts`: pass `"make"` and assert the notice starts with `[Output of "make" too long`. `prompt.test.ts`: `saves a spilled tool result under the tool name and its first string argument` (args `{ url: "https://x.test/doc", n: 3 }` → `"<page.name> https://x.test/doc"`); `uses the tool name alone when no argument is a string`.
- [ ] **Step 3: Run the three files; expect compile failures.**
- [ ] **Step 4: Implement the store, the capper, and `InvokedCall.namedArgs`.**
- [ ] **Step 5: Implement the Agency side** and add a paragraph on `source` to `docs/dev/stdlib/spill.md` and the module doc example in `spill.agency`.
- [ ] **Step 6: `make`, typecheck, run the three files plus** `grep -rl "full output saved as" tests/ lib/ --include=*.ts --include=*.json --include=*.agency` and run whatever that finds.
- [ ] **Step 7: Commit** `spill: keep a readable source beside every saved output`.

---

### Task 3: The `summary` and `silent` presentation kinds

**Files:**
- Modify: `lib/stdlib/agentToolTrace.ts`
- Create: `lib/utils/formatElapsed.ts` (moved from `lib/eval/run/statusBoard.ts:21`; update that import)
- Test: `lib/stdlib/agentToolTrace.test.ts`

**Interfaces (all in `agentToolTrace.ts` unless said):**
- `ToolEndEvent` gains `args?: unknown`, `timeTaken?: number`.
- `TraceOptions` gains `toolNames: boolean` and `spillSource: SpillLookup` where `type SpillLookup = (name: string) => string | null`. `traceOptionsForHost(host, toolNames = false)` sets `spillSource` to `(name) => findOutputSource(currentRun(), name)`. `_printAgentTrace(event, toolNames = false)`. Tests build options with `() => null`.
- `type ToolArgs = Record<string, unknown>`.
- Helpers, each exported for its own test: `text(value: unknown): string | null` (string as-is, number as digits, string array space-joined, else null; then first line only with `…` when more lines followed); `filePath(args)` (`dir/filename`, `dir` dropped when missing or `.`); `lineRange(args)` (the `sliceLines` rule: start = offset>0 ? offset : 1; end = limit>0 ? start+limit-1 : "end"; null when both unset); `firstLine(value)` (= `text`); `flag(args, key, word)` (word when `args[key] === true`, else null); `spillOutput(name, lookup)` (`output of <source>`, else the raw name); `prefixed(prefix, value)` (`prefix + text(value)` or null).
- `type ShowParts = (args: ToolArgs, lookup: SpillLookup) => (string | null)[]`.
- `type CountSummary = { count: string }`; `type ExitCodeSummary = { exitCode: true }`; `type CustomSummary = { custom: (value: unknown, args: ToolArgs) => string | null; failsWhen?: (value: unknown) => boolean; detail?: (value: unknown) => string | null }`; `type ResultSummary = "none" | "verdict" | "preview" | CountSummary | ExitCodeSummary | CustomSummary`. `exitCode` prints `exit N`, fails when N ≠ 0, and its detail is `commandDetail(value)`.
- `commandDetail(stdout: unknown, stderr: unknown): string | null`: stderr when nonempty, else stdout; a spill notice (starts with `[Output`) is cut to its first line; null when both empty.
- `type FailureSummary = (message: string) => { line: string | null; detail: string | null } | null`.
- `type SummaryPresentation = { kind: "summary"; label: string; show: ShowParts; twoLines: boolean; result: ResultSummary; failure?: FailureSummary }`; `type SilentPresentation = { kind: "silent" }`.
- Line: `<mark> <label> <parts joined by " "> · <result> · <elapsed>`, separators only between present pieces; detail rows under it. `outcome: "plain"` counts as success. Elapsed from `formatElapsed` when `twoLines` and `timeTaken >= 1000`.
- In this task add rows `read`, `safeBash` (result none, failure added in Task 4), `gitAdd`, `ghPrGet`, `question` (silent).

- [ ] **Step 1: Tests** in `describe("summary presentations")`: read one-line with and without range (`✓ Read a.md`, `✓ Read packages/x/a.md` for dir, `✓ Read a.md lines 460–579`, `lines 1–120` for offset 0, `lines 460–end`); safeBash two lines with elapsed `14s` and none at 900 ms; multi-line command → `● Run echo a…` (Review Focus 7); failure under the line; skipped missing argument and numbers/arrays (`✓ gh pr get #1310`, `● git add a b`); silent `question`; unknown tool keeps `● Tool call  mystery`; summary line shows the name only with `toolNames: true` (`✓ Read a.md  read`). Helper tests: `lineRange`, `text`, `filePath`, `commandDetail` (stderr wins; notice cut to first line).
- [ ] **Step 2: Run; expect failures.**
- [ ] **Step 3: Implement.** One `describeSummary(event, presentation, options)` holds every branch. Add `plain: TraceOptions` with `toolNames: false, spillSource: () => null` to the tests.
- [ ] **Step 4: Run and typecheck.**
- [ ] **Step 5: Commit** `agentToolTrace: summary and silent presentation kinds`.

---

### Task 4: Result summarizers

**Files:** `lib/stdlib/agentToolTrace.ts`, its test.

**Interfaces:** `summarizeGrep(value, args)` → `"12 lines in 3 files"`, or `"3 files"` when the result is a string array (`filesOnly`); `summarizeGrepSpill(value)` → lines, summing `matches.length` when grouped by pattern; `summarizeTypecheck(value)` → `"clean"` or `"3 errors, 1 warning"` with `failsWhen` errors > 0; `summarizeTestReport(value)` → `"7 passed"`/`"5 passed, 2 failed"`, fails when any `cases[].pass` is false; `summarizeBytes(value)` → `"2.1 KB"`/`"812 B"`; `summarizeEditCount(value, args)` → `"3 edits"`; `safeBashFailure(message)` → parses `{command, exitCode, stderr, stdout}` and returns `{ line: "exit 2", detail: commandDetail(stdout, stderr) }`, null otherwise. Rows added: `grep`, `grepSpill`, `typecheck`, `testFile`, `write`, `edit`, `exec`, `agencyCli`; `safeBash` gains `failure`.

- [ ] **Step 1: Tests**, one per summarizer with real-shaped values, plus: safeBash JSON failure → `✗ Run make · exit 2\n  │ boom\n  │ bang`; non-JSON failure → message in full (Review Focus 3); failure with empty stderr shows stdout; a notice stderr shows one line; `exec` plain result `{ exitCode: 128, stdout: "", stderr: "fatal: bad" }` with `outcome: "plain"` → `✗ Run git log · exit 128\n  │ fatal: bad` (Review Focus 6); grep `filesOnly` string array → `3 files`; grepSpill grouped → lines summed; typecheck has no filename: `✓ Typecheck · clean`.
- [ ] **Step 2–4: run, implement, run and typecheck.**
- [ ] **Step 5: Commit** `agentToolTrace: result summarizers`.

---

### Task 5: The rest of the table, and the coverage test

**Files:** `lib/stdlib/agentToolTrace.ts`, its test; `lib/agents/agency-agent/brains/coordinator/tests/toolPresentations.agency` + `.test.json` (new, beside `toolWiring.agency`).

**Interfaces:** export `presentedToolNames(): string[]` and `GENERIC_BY_DESIGN_PREFIXES`? No: the Agency test carries its own allow-list. Rows, keyed by model-facing name, per the spec table. Shapes that need a word here:
- `ls`: `[text(a.dir), flag(a,"recursive","recursive")]`, count "entries". `glob`: `[text(a.pattern), prefixed("in ", a.dir)]`, count "files". `grep`: `[text(a.pattern), prefixed("in ", a.path), flag(a,"filesOnly","files only"), flag(a,"invert","inverted")]`. `write`: `[filePath(a), a.mode === "append" ? "append" : null]`, custom bytes of `a.content`. `edit`: `[filePath(a)]`.
- `readSpill`: `[spillOutput(a.filename, lookup), lineRange(a)]`. `grepSpill`: `[text(a.pattern), prefixed("in ", spillOutput(a.filename, lookup))]`.
- Git read (one line, none): `gitIsRepo` "git rev-parse"; `gitStatus`; `gitLog [text(a.path), text(a.ref)]`; `gitDiff [text(a.ref), text(a.ref2), text(a.path), flag(a,"staged","--staged")]`; `gitShow [text(a.ref)]`; `gitBlame [text(a.path)]`; `gitBranchList` "git branch"; `gitRemoteList` "git remote"; `gitStashList` "git stash list".
- Git write (two lines, none): `gitAdd [text(a.paths), flag(a,"all","--all")]`; `gitCommit [firstLine(a.message)]`; `gitCheckout [text(a.target), flag(a,"force","--force")]`; `gitSwitch [text(a.branch)]`; `gitBranchCreate` "git branch" `[text(a.branch)]`; `gitBranchDelete` "git branch -d" `[text(a.branch), flag(a,"force","--force")]`; `gitStashPush`, `gitStashPop` no parts; `gitRestore [text(a.paths)]`.
- GitHub (two lines, none): `gh pr <x> [prefixed("#", a.number)]` for get, diff, files, reviews, review comments, checks, comment, approve; `ghPrReview [prefixed("#", a.number), text(a.event)]`; `ghPrList`, `ghIssueList` no parts; `ghIssueSearch [text(a.query)]`; `ghIssueGet`, `ghIssueComments`, `ghIssueComment`, `ghIssueClose` `[#number]`; `ghIssueCreate [text(a.title)]`; `ghIssueLabel [#number, text(a.labels)]`.
- Web (two lines): `fetchMarkdown "Fetch" [text(a.baseUrl) + path when set]` custom bytes; `wikipedia_search [text(a.query)]`; `wikipedia_summary`, `wikipedia_article [text(a.title)]`.
- Agency: `parseAST "Parse"` one line verdict. Docs: `agencyGuide`, `agencyCliDocs`, `agencyDiagnostics`, `agencyStdlib`, `agencyAgent` "Docs" `[text(a.filename)]`. Skills: `skill [text(a.name)]`; `coordinator_skills`, `skills_coding`, `superpowersSkill` "Skill" `[text(a.filename ?? a.name)]` (check each parameter name in `stdlib/skills.agency` and `lib/agents/agency-agent/lib/claudeSkills.agency`).
- Memory: `remember` two lines, no parts; `recall [text(a.query)]` one line.
- Silent: `saveDraft`, `question`, `whatIAmDoing`.
- Images: `generateImageFile "Generate image" [prefixed("→ ", a.path)]` two lines; `viewImageFile "View" [text(a.path)]`.
- Coordinator: `learnSkill "Learn skill" [text(a.name)]` two; `writeToolFor "Write tool" [text(a.name)]` two; `learnTools "Learn tools" [text(a.source?.module ?? a.source?.filename)]` two; `listPresets "Preset list"`, `savePreset`/`deletePreset`/`setDefaultPreset` "Preset save/delete/default" `[text(a.name)]`, `useLlmOptions "LLM options"`, all one line; `elapsedTime "Elapsed"` one line, preview.
- Code agent: `setAgentCwd "Working directory" [prefixed("→ ", a.dir)]`; `getAgentCwd "Working directory"` preview.
- `agent` kind completion appends ` · <elapsed>` when `timeTaken >= 1000`.

- [ ] **Step 1: Tests**: spill source shown and raw-name fallback (Review Focus 4); commit first line; write `append`; `--force` on a forced checkout; subagent completion `✓ Code finished · 2m 14s`.
- [ ] **Step 2: The coverage test** in Agency: walk `turnTools(turnStart)` from the coordinator and `buildTools()` from `std::agents/coding`, read each `.name`, and assert it is in `presentedToolNames()` or in an allow-list of generic-by-design names (`learned_` prefix, MCP tools, generated tools, Claude skill tools). Import `presentedToolNames` from `agency-lang/stdlib-lib/agentToolTrace.js`. Model the file on `toolWiring.agency`.
- [ ] **Step 3: Fill the table; run both tests and typecheck; `make` for the Agency test.**
- [ ] **Step 4: Commit** `agentToolTrace: presentation rows for every agent tool`.

---

### Task 6: Wire the agent

**Files:** `lib/agents/agency-agent/lib/trace.agency:38-64`; `tests/agency-js/agent-tool-trace/{agent.agency,test.js,fixture.json}`.

- [ ] **Step 1:** In `trace.agency`, delete `SKIP_TRACING` and the two early returns; pass `args: data.args`, `timeTaken: data.timeTaken`, and `isDebug()` as the second argument of `_printAgentTrace`. No tool name appears in this file.
- [ ] **Step 2:** In `tests/agency-js/agent-tool-trace`, keep every existing assertion (the fixture tools `echo`, `successful`, `failedFixture` have no rows, so their generic output is unchanged) and add a `read`-shaped fixture tool renamed to `read` returning `"text"`, asserting `summaryLine: output.includes("✓ Read a.md lines 1–20")` and `noSummaryStart: !output.includes("● Tool call  read")`.
- [ ] **Step 3:** `make`, `pnpm run build`, run that test and the Task 5 Agency test.
- [ ] **Step 4:** By hand: `pnpm run agency agent -p "read the first 20 lines of package.json, then grep it for the word name" --verbose` with a policy that approves reads (never approve-all). Expect `✓ Read package.json lines 1–20` and a `Grep` line. One real model call.
- [ ] **Step 5: Commit** `agency agent: one summary line per tool call`.

---

### Task 7: The dev doc, the index, and the PR

- [ ] **Step 1:** `docs/dev/agents/tool-output.md`: add `## Guidelines` (the spec's ten), rewrite `## Display rules` for the four kinds, the `show` helpers, the line shape, the elapsed rule, `toolNames`, the interrupt-prompt note, the generic-by-design tools, and the sentence "Adding a tool to an agent toolkit means adding a row to `TOOL_PRESENTATIONS`, or adding its name to the coverage test's allow-list in review." Update the example block at the top. Mechanism and rule only.
- [ ] **Step 2:** Update the `tool-output.md` index line in `CLAUDE.md` and in `.claude/skills/agency-agent-docs/SKILL.md` (grep for it).
- [ ] **Step 3:** `pnpm run lint:structure`, `pnpm run fmt:ts <changed files>`, final typecheck. Commit `docs: tool trace display guidelines`.
- [ ] **Step 4:** Push, open the PR against `main` with the description in a file. Stop; the owner merges.
