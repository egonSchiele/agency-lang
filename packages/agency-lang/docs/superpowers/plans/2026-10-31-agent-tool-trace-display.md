# Agent Tool Trace Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agency agent` prints one short line per tool call that names what the tool touched and whether it worked, driven by a data table, with readable names for saved tool output.

**Architecture:** The runtime's `onToolCallEnd` hook gains the call's arguments, so a line can be built when the call settles. `TOOL_PRESENTATIONS` in `lib/stdlib/agentToolTrace.ts` gains a `summary` kind (label, arguments to show, one or two lines, result summarizer) and a `silent` kind. The spill store keeps a readable `source` beside each saved output, and the readers' trace lines show it.

**Tech Stack:** TypeScript (vitest), Agency (`trace.agency`, `spill.agency`, `safeBash.agency`), typestache not involved.

**Spec:** `docs/superpowers/specs/2026-10-31-agent-tool-trace-display-design.md` (same directory tree as this plan). Read it first. The per-tool table there is the source of truth for every row; this plan tells you where each row goes and how to test it.

## Global Constraints

- Paths are relative to `packages/agency-lang`. Work in the worktree `worktree-tool-trace-display`.
- Project rules: types not interfaces, objects not maps, arrays not sets, no dynamic imports. `lib/runtime` must not import from `lib/stdlib/agentToolTrace.ts`.
- Run `pnpm run typecheck` after every TypeScript edit and `make` after editing any `.agency` file under `stdlib/` or `lib/agents/`. Run `pnpm run fmt:ts` on the files you changed only (never repo-wide from this worktree). Run `pnpm run lint:structure` before the last commit.
- Tests: `pnpm vitest run <file>` for one file, output saved to a file in the scratchpad. No LLM calls in any new test. Do not run the whole agency test suite.
- Commit messages go in a file and are passed with `git commit -F <file>` (apostrophes break the command line). Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Existing displays for todo lists, web searches, and subagent announcements keep their current output byte for byte, except where a task below says otherwise. The existing tests in `lib/stdlib/agentToolTrace.test.ts` must keep passing unchanged, apart from the one assertion Task 3 names.
- The spec's display rules are law: one line for instant tools, `●` blue start and `✓`/`✗` end for two-line tools, failures in full under the line, elapsed only when at least 1000 ms and only on two-line tools, no result preview except where the table says `preview`.

## Review Focus

Inputs the spec implies but no task's tests exercise unless added here. Each line's test is added to the owning task.

1. **A `summary` row names an argument the call did not pass** (model omitted an optional parameter). Expected: the argument is skipped, the line still prints. Test in Task 3.
2. **A numeric or array argument in `show`** (`number: 1310`, `paths: ["a","b"]`, `args: ["fmt","x"]`). Expected: numbers print as digits, arrays join with spaces, never `[object Object]`. Test in Task 3.
3. **A `safeBash` failure whose message is not the JSON shape** (an interrupt rejection string). Expected: the message prints in full under the line, no crash. Test in Task 4.
4. **A `readSpill` name that is not in the store** (evicted, or another run's). Expected: the line falls back to the raw name. Test in Task 5.
5. **An `onToolCallEnd` after a resume from a checkpoint.** Expected: `data.args` is the same object the start hook got. Test in Task 1.

---

### Task 1: `onToolCallEnd` carries the call's arguments

**Files:**
- Modify: `lib/runtime/hooks.ts:53`
- Modify: `lib/runtime/prompt.ts:1686-1693` (the end hook inside the `round.${round}.tool.${callSlug}.end` step)
- Create: `tests/agency-js/tool-end-args/agent.agency`, `tests/agency-js/tool-end-args/test.js`

**Interfaces:**
- Produces: `onToolCallEnd: { toolName: string; args: Record<string, unknown>; result: any; timeTaken: number }`. `args` is the same `namedArgs` object `onToolCallStart` received for that call.

- [ ] **Step 1: Write the failing agency-js test**

Copy the shape of `tests/agency-js/block-callback-tool-resume/test.js` (a scripted `llmClient` with two rounds, `__setLLMClient`, `main`, `respondToInterrupts`). The agent file:

```agency
def interruptTool(name: string): string {
  interrupt("approve")
  return "tool result"
}

let seen: any[] = []
callback("onToolCallEnd") as data {
  seen.push({ toolName: data.toolName, args: data.args })
}
export def seenCalls(): any[] { return seen }

node main() {
  return llm("call tools", { tools: [interruptTool] })
}
```

The test calls the tool with `{ name: "FOO" }` in round one, resumes the interrupt with approve, and asserts:

```js
assert.deepEqual(seenCalls(), [{ toolName: "interruptTool", args: { name: "FOO" } }]);
```

Check how neighbouring agency-js tests export and assert (`tests/agency-js/tool-rejection/test.js`) and follow that style; the harness is described in `docs/misc/TESTING.md`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm run agency test js tests/agency-js/tool-end-args > <scratchpad>/t1.log 2>&1; tail -20 <scratchpad>/t1.log`
Expected: FAIL, `args` is `undefined`.

- [ ] **Step 3: Add `args` to the hook type and the emit site**

In `hooks.ts` add `args: Record<string, unknown>` to `onToolCallEnd`. In `prompt.ts` the end step is inside the same closure as the start hook, which has `namedArgs` in scope (`prompt.ts:1591`); pass `args: namedArgs`. Confirm `namedArgs` is reached from the persisted tool call on a resume, not from a value only the invoke step computes. If it is not, read it back from `toolArgumentsFor(handler, toolCall)` as the round setup does at `prompt.ts:1417`.

- [ ] **Step 4: Typecheck and run the test**

Run: `pnpm run typecheck > <scratchpad>/tc1.log 2>&1; tail -5 <scratchpad>/tc1.log` then the Step 2 command.
Expected: typecheck clean; test PASS.

- [ ] **Step 5: Commit**

```
onToolCallEnd: pass the call's arguments
```

---

### Task 2: A readable `source` on every saved output

**Files:**
- Modify: `lib/runtime/toolOutputStore.ts` (`SavedOutput`, `storeOutput`, new `findOutputSource`, `outputNotice`)
- Modify: `lib/runtime/toolInvocation.ts:215-245` (`capToolResultForLlm`, `toolResultCapper`, new `spillSource`)
- Modify: `lib/runtime/prompt.ts:694,962,992,1325` (thread `namedArgs` into `capForLlm`)
- Modify: `lib/stdlib/spill.ts` (`_keepOutput`)
- Modify: `stdlib/spill.agency` (`keepOutput`)
- Modify: `stdlib/safeBash.agency:939,955,961,963` and `stdlib/safeBash/actions.agency:144,151`
- Modify: `docs/dev/stdlib/spill.md` (one paragraph on `source`)
- Test: `lib/runtime/toolOutputStore.test.ts`, `lib/stdlib/spill.test.ts`, `lib/runtime/prompt.test.ts` (the `capToolResultForLlm` describe)

**Interfaces:**
- Produces:
  - `type SavedOutput = { name: string; text: string; source?: string }`
  - `storeOutput(run: Run, text: string, source: string): string`
  - `findOutputSource(run: Run, name: string): string | null` (null when not found or when the entry has no source)
  - `outputNotice(text, name, exitCode, readers, maxChars?, source?: string)`: when `source` is given, the first line reads `[Output of "<source>" too long to return in full: ...]`; without it, unchanged.
  - `SPILL_SOURCE_CHARS = 80` in `toolOutputStore.ts`. `storeOutput` cuts `source` to that length, so no caller cuts.
  - `spillSource(tool: ToolIdentity, args: Record<string, unknown>): string`: the tool name, then a space and the first argument whose value is a string; the tool name alone when no argument is a string.
  - `capToolResultForLlm(result, cap, spill, tool, args: Record<string, unknown>)` and `toolResultCapper(cap, spill)` returning `(result, tool, args) => ...`.
  - `_keepOutput(text: string, exitCode: number, source: string): string` and Agency `keepOutput(text: string, exitCode: number, source: string): string`.

- [ ] **Step 1: Write the failing store tests** in `lib/runtime/toolOutputStore.test.ts`

```ts
it("keeps a readable source beside the text", () => {
  withRun((run) => {
    const name = storeOutput(run, "x".repeat(10), "pnpm run typecheck");
    expect(findOutputSource(run, name)).toBe("pnpm run typecheck");
    const long = storeOutput(run, "y", "z".repeat(200));
    expect(findOutputSource(run, long)).toBe("z".repeat(SPILL_SOURCE_CHARS));
    expect(findOutputSource(run, "2026-01-01T00-00-00-000Z-abcdef.log")).toBeNull();
  });
});
it("reads an entry saved without a source as having none", () => {
  withRun((run) => {
    const name = storeOutput(run, "x", "cmd");
    const store = run.globals.get(GlobalStore.INTERNAL_MODULE, "__toolOutput") as { entries: { source?: string }[] };
    delete store.entries[0].source;
    expect(findOutputSource(run, name)).toBeNull();
    expect(findOutput(run, name)).toBe("x");
  });
});
it("names the source in the notice", () => {
  const notice = outputNotice("a\n".repeat(2000), "n.log", 1, DEFAULT_READERS, Infinity, "pnpm test");
  expect(notice.startsWith('[Output of "pnpm test" too long to return in full:')).toBe(true);
});
```

Update the existing `storeOutput(run, text)` calls in this file to pass a source. The second test reaches into the run's globals to drop the field: no public call writes an entry without one, and that is the shape an old checkpoint carries.

- [ ] **Step 2: Write the failing spill and capper tests**

In `lib/stdlib/spill.test.ts`, the "saves long output" case passes `"make"` as the third argument and asserts the notice starts with `[Output of "make" too long`. In `lib/runtime/prompt.test.ts` under `capToolResultForLlm`:

```ts
it("saves a spilled tool result under the tool name and its first string argument", () => {
  withRun((run) => {
    const out = capToolResultForLlm("a".repeat(5000), 10000, spillOver(run, 500), page, { url: "https://x.test/doc", n: 3 }) as string;
    const name = /full output saved as (\S+) ---/.exec(out)![1];
    expect(findOutputSource(run, name)).toBe("fetchMarkdown https://x.test/doc");
  });
});
it("uses the tool name alone when no argument is a string", () => { /* args: { n: 3 } → source equals tool name */ });
```

(`page` is the existing `ToolIdentity` fixture in that describe; use its `name` in the expected string.)

- [ ] **Step 3: Run the three test files and confirm they fail to compile or fail**

Run: `pnpm vitest run lib/runtime/toolOutputStore.test.ts lib/stdlib/spill.test.ts lib/runtime/prompt.test.ts > <scratchpad>/t2.log 2>&1; grep -E "✓|✗|FAIL|Error" <scratchpad>/t2.log | head -30`

- [ ] **Step 4: Implement the store and the capper**

`toolOutputStore.ts`: add the optional `source` to `SavedOutput`, store it in `storeOutput`, add `findOutputSource`, and give `outputNotice` the optional `source` that changes only its first line. `toolInvocation.ts`: add `spillSource`, thread `args` through `capToolResultForLlm` to `storeOutput(spill.run, saved, spillSource(tool, args))` and to `outputNotice`. `prompt.ts`: the three `capForLlm` call sites pass the call's `namedArgs` (the rejection and error paths at 962 and 992 destructure `call`; add `namedArgs` to what they take, or pass `{}` if it is not on that record and say so in a comment).

- [ ] **Step 5: Implement the Agency side**

`spill.ts`: `_keepOutput(text, exitCode, source)` passes `source` to both `storeOutput` and `outputNotice`. `spill.agency`: `keepOutput` gains `source: string` and its docstring says what to pass ("the command that produced the output"). `safeBash.agency`: the `echo` arm passes `content` (the store cuts it); `runAgency` and `cliOutcome` pass `"agency " + args.join(" ")` (thread `args` into `cliOutcome`). `actions.agency` `runBash` passes `command`. Update the module doc comment example in `spill.agency` and add a paragraph to `docs/dev/stdlib/spill.md`.

- [ ] **Step 6: Build, typecheck, run the tests**

Run: `make > <scratchpad>/make2.log 2>&1; tail -5 <scratchpad>/make2.log`, then `pnpm run typecheck`, then the Step 3 command.
Expected: all green. Also run `pnpm vitest run lib/stdlib/safeBash` (whatever safeBash unit tests exist) and the agency tests for safeBash if any name `keepOutput`; grep `tests/` for `full output saved as` and run those files.

- [ ] **Step 7: Commit**

```
spill: keep a readable source beside every saved output
```

---

### Task 3: The `summary` and `silent` presentation kinds

**Files:**
- Modify: `lib/stdlib/agentToolTrace.ts` (types at 8-49, `TOOL_PRESENTATIONS` at 66, `describeToolEvent` at 157, `toolHeading` at 334, `traceOptionsForHost` at 104, `_printAgentTrace` at 125)
- Create: `lib/utils/formatElapsed.ts` (moved from `lib/eval/run/statusBoard.ts:21`; update that file's import and any test that imports it from there)
- Test: `lib/stdlib/agentToolTrace.test.ts`

**Interfaces:**
- Produces, all exported from `agentToolTrace.ts`:
  - `ToolEndEvent` gains `args?: unknown` and `timeTaken?: number` (ms).
  - `TraceOptions` gains `toolNames: boolean` and `spillSource?: (name: string) => string | null`. `traceOptionsForHost(host, toolNames = false)` fills both: `spillSource` is `(name) => findOutputSource(currentRun(), name)`, imported from `lib/runtime/toolOutputStore.ts` beside the existing `currentHost` import. `_printAgentTrace(event, toolNames = false)`. Tests pass their own `spillSource` or none.
  - Argument forms, each a named type:
    - `type ArgumentValue = { key: string; prefix?: string; limit?: "line"; firstLine?: boolean; spillSource?: boolean }`: prints the argument's value (strings as-is, numbers as digits, string arrays joined by spaces, anything else skipped). `firstLine` keeps only the first line. `spillSource` looks the value up through `options.spillSource` and prints `output of <source>` when found, else the value.
    - `type ArgumentRange = { range: { offset: string; limit: string } }`: `lines {offset}–{offset+limit}` when either is set and nonzero, `lines {offset}–end` when `limit` is 0 and `offset` set.
    - `type ArgumentText = { text: string; when: string; equals: unknown }`: prints `text` when `args[when] === equals`. Covers booleans (`{ text: "recursive", when: "recursive", equals: true }`) and strings (`{ text: "append", when: "mode", equals: "append" }`).
    - `type SummaryArgument = ArgumentValue | ArgumentRange | ArgumentText`.
  - Result summaries, each a named type:
    - `type CountSummary = { count: string }`: `12 matches` for an array result, singular for 1.
    - `type ExitCodeSummary = { exitCode: true }`: `exit N` from `value.exitCode`.
    - `type CustomSummary = { custom: (value: unknown, args: Record<string, unknown>) => string | null; failsWhen?: (value: unknown) => boolean }`: `failsWhen` switches the mark to `✗` on a success result (typecheck errors, failed test cases).
    - `type ResultSummary = "none" | "verdict" | "preview" | CountSummary | ExitCodeSummary | CustomSummary`. `verdict` prints nothing extra on success. `preview` is today's dim text.
  - `type FailureSummary = (message: string) => { line: string; detail: string } | null`.
  - `type SummaryPresentation = { kind: "summary"; label: string; show: SummaryArgument[]; twoLines: boolean; result: ResultSummary; failure?: FailureSummary }`. `failure` is used by Task 4 for `safeBash`.
  - `type SilentPresentation = { kind: "silent" }`.
  - Elapsed text comes from the existing `formatElapsed` in `lib/eval/run/statusBoard.ts`, which already prints `47s` and `5m 17s`. Move it to `lib/utils/formatElapsed.ts`, import it from `statusBoard.ts` and from here, and keep its tests where they are. The renderer applies the "at least 1000 ms" rule before calling it; `formatElapsed` itself does not change.
  - Line shape for a summary: `<mark> <label> <shown args joined by " "> · <result> · <elapsed>` with `·` separators only between present parts. Start line for a two-line tool: `● <label> <args>` in `active` style. End mark `✓` success style or `✗` error style. On failure the failure message is a `rows` entry in error style; the result summary is omitted.
  - Tool name suffix: `toolHeading` appends the dim tool name only when `options.toolNames` is true. This changes the generic headings too.

- [ ] **Step 1: Write the failing tests** in a new `describe("summary presentations")` block. The table stays private; test through real rows. Add the `read`, `safeBash`, `gitAdd`, `ghPrGet`, and `question` rows in this task, with the shapes the spec gives, and test through them:

```ts
it("prints one line for read, with the range only when set", () => {
  expect(formatAgentTrace({ kind: "toolStart", toolName: "read", args: { filename: "a.md" } }, plain)).toBe("");
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "read", args: { filename: "a.md", dir: "." }, value: "text", outcome: "success", timeTaken: 12 }, plain)).toBe("✓ Read a.md");
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "read", args: { filename: "a.md", offset: 460, limit: 120 }, value: "t", outcome: "success" }, plain)).toBe("✓ Read a.md lines 460–580");
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "read", args: { filename: "a.md", offset: 460, limit: 0 }, value: "t", outcome: "success" }, plain)).toBe("✓ Read a.md lines 460–end");
});
it("prints a start and an end for a two-line tool, with elapsed time from one second", () => {
  expect(formatAgentTrace({ kind: "toolStart", toolName: "safeBash", args: { command: "pnpm run typecheck" } }, plain)).toBe("● Run pnpm run typecheck");
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "safeBash", args: { command: "pnpm run typecheck" }, value: "", outcome: "success", timeTaken: 14200 }, plain)).toBe("✓ Run pnpm run typecheck · 14s");
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "safeBash", args: { command: "ls" }, value: "", outcome: "success", timeTaken: 900 }, plain)).toBe("✓ Run ls");
});
it("puts a failure message in full under the line and drops the result summary", () => {
  const out = formatAgentTrace({ kind: "toolEnd", toolName: "read", args: { filename: "a.md" }, value: "Tool call rejected: no", outcome: "failure" }, plain);
  expect(out).toBe("✗ Read a.md\n  │ Tool call rejected: no");
});
it("skips a shown argument the call did not pass, and prints numbers and arrays plainly", ...);  // Review Focus 1 and 2: a row with show [{key:"number", prefix:"#"}, {key:"paths"}] through gitAdd/ghPrGet rows, expect "✓ gh pr get #1310" and "● git add a b"
it("prints nothing for a silent tool", () => { /* question start and end both "" */ });
it("keeps the generic display for an unknown tool, without the tool name unless asked", () => {
  expect(formatAgentTrace({ kind: "toolStart", toolName: "mystery", args: { a: 1 } }, plain)).toBe("● Tool call\n  │ a: 1");
  expect(formatAgentTrace({ kind: "toolStart", toolName: "mystery", args: { a: 1 } }, { ...plain, toolNames: true })).toBe("● Tool call  mystery\n  │ a: 1");
});
```

Change the one existing assertion at `agentToolTrace.test.ts:54` from `"✓ Tool finished  echo\n  │ done"` to `"✓ Tool finished\n  │ done"`, and make `plain` include `toolNames: false`. The `gitAdd` and `ghPrGet` rows used above are added in this task with the shapes the spec gives (`label: "git add"`, `show: [{ key: "paths" }]`, two lines; `label: "gh pr get"`, `show: [{ key: "number", prefix: "#" }]`, two lines). The one `describeSummary` function holds every branch over the argument and result forms; rows never contain code except a `custom` or `failure` function.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run lib/stdlib/agentToolTrace.test.ts > <scratchpad>/t3.log 2>&1; grep -E "✓|✗|FAIL" <scratchpad>/t3.log | head -40`

- [ ] **Step 3: Implement the types, `describeSummary`, the `silent` kind, and the `toolNames` and `spillSource` options**

Add the types from Interfaces. In `describeToolEvent`, dispatch on `presentation.kind`: `silent` returns null for both phases; `summary` returns null at start when `twoLines` is false, else the start block; at end builds the line from `args`, `outcome`, `value`, `timeTaken`. Argument values go through the existing `sanitize` and `limit` machinery (`limit: "line"` means no character limit; the renderer already wraps). Keep `describeToolStart`/`describeToolEnd` for the generic path. `traceOptionsForHost` and `_printAgentTrace` take `toolNames`; `printAgentTrace(host, event, toolNames = false)`.

- [ ] **Step 4: Run tests and typecheck**

Run the Step 2 command and `pnpm run typecheck`. Expected: PASS, clean.

- [ ] **Step 5: Commit**

```
agentToolTrace: summary and silent presentation kinds
```

---

### Task 4: Result summarizers and the `safeBash` failure parser

**Files:**
- Modify: `lib/stdlib/agentToolTrace.ts`
- Test: `lib/stdlib/agentToolTrace.test.ts`

**Interfaces:**
- Produces, private to the file but reachable through rows: `summarizeGrep(value)` → `"12 lines in 3 files"` (distinct `file` fields; singulars for 1); `summarizeTypecheck(value)` → `"clean"` or `"3 errors, 1 warning"` (zero parts omitted; reads `errors`/`warnings` arrays of a `TypeCheckReport`, which arrives unwrapped from its Result); `summarizeTestReport(value)` → `"7 passed"` or `"5 passed, 2 failed"` from `cases[].pass`; `summarizeBytes(value)` → `"2.1 KB"` from a string's length, `"812 B"` under 1000; `summarizeEditCount(value, args)` → `"3 edits"` from `args.edits.length`; `safeBashFailure(message)` → parses `{command, exitCode, stderr, stdout}` JSON and returns `{ line: "exit 2", detail: stderr }`, or null when the message is not that shape (a `FailureSummary` from Task 3).
- The `typecheck` and `testFile` rows set `failsWhen` (Task 3's `CustomSummary`) so errors or failed cases print `✗` on a success Result.

- [ ] **Step 1: Write the failing tests**, one per summarizer, with real-shaped values:

```ts
it("counts grep lines and distinct files", () => {
  const value = [{ file: "a", line: 1, text: "" }, { file: "a", line: 2, text: "" }, { file: "b", line: 1, text: "" }];
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "grep", args: { pattern: "x", path: "lib" }, value, outcome: "success" }, plain)).toBe('✓ Grep "x" in lib · 3 lines in 2 files');
});
it("reports typecheck as clean or as error and warning counts, red when errors", ...);   // value { errors: [], warnings: [] } → "✓ Typecheck f.agency · clean"; { errors: [1,2,3], warnings: [1] } → "✗ Typecheck f.agency · 3 errors, 1 warning"
it("reports test cases passed and failed", ...);  // { pass: false, cases: [{pass:true},{pass:true},{pass:false}] } → "✗ Test t.json · 2 passed, 1 failed"
it("shows the exit code and stderr for a safeBash failure, and the raw message otherwise", () => {
  const message = JSON.stringify({ command: "make", exitCode: 2, stderr: "boom\nbang", stdout: "" });
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "safeBash", args: { command: "make" }, value: message, outcome: "failure" }, plain)).toBe("✗ Run make · exit 2\n  │ boom\n  │ bang");
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "safeBash", args: { command: "make" }, value: "rejected by policy", outcome: "failure" }, plain)).toBe("✗ Run make\n  │ rejected by policy");  // Review Focus 3
});
it("sizes a write and counts edits", ...);  // write → "✓ Write a.md · 2.1 KB" from args.content of 2100 chars; edit → "✓ Edit a.ts · 3 edits"
```

The `grep`, `typecheck`, `testFile`, `write`, `edit` rows are added in this task with the spec's shapes.

- [ ] **Step 2: Run, confirm failure. Step 3: implement. Step 4: run and typecheck.**

Same commands as Task 3.

- [ ] **Step 5: Commit**

```
agentToolTrace: result summarizers for grep, typecheck, tests, writes, and safeBash failures
```

---

### Task 5: The rest of the table, and spill sources on the readers

**Files:**
- Modify: `lib/stdlib/agentToolTrace.ts` (`TOOL_PRESENTATIONS`)
- Test: `lib/stdlib/agentToolTrace.test.ts`

**Interfaces:**
- Consumes: `options.spillSource` and the `ArgumentValue.spillSource` flag from Task 3.
- Produces: every row in the spec's per-tool table, keyed by the model-facing tool name. The list, by group, with the exact `label` and `show`:
  - Files: `read` (Task 3), `ls` `List [{key:"dir"},{text:"recursive",when:"recursive",equals:true}]` count "entries"; `glob` `Glob [{key:"pattern"},{key:"dir",prefix:"in "}]` count "files"; `grep` (Task 4, add `{text:"files only",when:"filesOnly",equals:true}`); `write` `Write [{key:"filename"},{text:"append",when:"mode",equals:"append"}]` one line, custom `summarizeBytes` on `args.content`; `edit` (Task 4).
  - Shell: `safeBash` (Task 3), `exec` `Run [{key:"command"},{key:"args"}]` two lines, exitCode; `readSpill` `Read [{key:"filename",spillSource:true},{range:{offset:"offset",limit:"limit"}}]` one line, none; `grepSpill` `Grep [{key:"pattern"},{key:"filename",spillSource:true,prefix:"in "}]` one line, count "lines".
  - Git read, one line, none: `gitIsRepo` `git rev-parse`; `gitStatus` `git status`; `gitLog` `git log [{key:"path"},{key:"ref"}]`; `gitDiff` `git diff [{key:"ref"},{key:"ref2"},{key:"path"},{text:"--staged",when:"staged",equals:true}]`; `gitShow` `git show [{key:"ref"}]`; `gitBlame` `git blame [{key:"path"}]`; `gitBranchList` `git branch`; `gitRemoteList` `git remote`; `gitStashList` `git stash list`.
  - Git write, two lines, none: `gitAdd` (Task 3); `gitCommit` `git commit [{key:"message",firstLine:true}]`; `gitCheckout` `git checkout [{key:"target"}]`; `gitSwitch` `git switch [{key:"branch"}]`; `gitBranchCreate` `git branch [{key:"branch"}]`; `gitBranchDelete` `git branch -d [{key:"branch"}]`; `gitStashPush` `git stash push`; `gitStashPop` `git stash pop`; `gitRestore` `git restore [{key:"paths"}]`.
  - GitHub, two lines, none: `ghPrGet` (Task 3); `ghPrList` `gh pr list`; `ghPrDiff`, `ghPrFiles`, `ghPrReviews`, `ghPrReviewComments`, `ghPrChecks` as `gh pr <x> [{key:"number",prefix:"#"}]`; `ghIssueGet`, `ghIssueComments` likewise with `gh issue`; `ghIssueList` `gh issue list`; `ghIssueSearch` `gh issue search [{key:"query"}]`; `ghPrReviewComment` `gh pr comment [#number]`; `ghPrReview` `gh pr review [#number, {key:"event"}]`; `ghPrApprove` `gh pr approve [#number]`; `ghIssueCreate` `gh issue create [{key:"title"}]`; `ghIssueComment` `gh issue comment [#number]`; `ghIssueClose` `gh issue close [#number]`; `ghIssueLabel` `gh issue label [#number, {key:"labels"}]`.
  - Web, two lines: `fetchMarkdown` `Fetch [{key:"url"},{key:"baseUrl"},{key:"path"}]` custom `summarizeBytes` on the result (the model may pass `url` or `baseUrl`; whichever is present prints); `wikipedia_search` `Wikipedia [{key:"query"}]`; `wikipedia_summary`, `wikipedia_article` `Wikipedia [{key:"title"}]`.
  - Agency: `typecheck`, `testFile` (Task 4; `testFile` shows `filename`, two lines); `parseAST` `Parse []` one line, verdict; `agencyCli` `agency [{key:"args"}]` two lines, exitCode.
  - Docs and skills, one line, none: `agencyGuide`, `agencyCliDocs`, `agencyDiagnostics`, `agencyStdlib`, `agencyAgent` as `Docs [{key:<the page argument>}]` (read the parameter name from `docsToolFromEntries` in `stdlib/skills.agency`); `skill` `Skill [{key:"name"}]`; `coordinator_skills` and the coding agent's `agentSkill("coding")` tool (read its name from `stdlib/skills.agency` `capToolName`/`agentSkill`) as `Skill [{key:<its name argument>}]`.
  - Memory, one line, none: `remember` `Remember []`; `recall` `Recall [{key:"query"}]`.
  - Silent: `saveDraft`, `question`, `whatIAmDoing`.
  - Images: `generateImageFile` `Generate image [{key:"path",prefix:"→ "}]` two lines, none; `viewImageFile` `View [{key:"path"}]` one line, none.
  - Coordinator: `learnSkill` `Learn skill [{key:"name"}]` two lines; `writeToolFor` `Write tool [{key:"name"}]` two lines; `listPresets` `Preset list`; `savePreset` `Preset save [{key:"name"}]`; `deletePreset` `Preset delete [{key:"name"}]`; `setDefaultPreset` `Preset default [{key:"name"}]`; `useLlmOptions` `LLM options`; all one line, none.
  - Code agent: `setAgentCwd` `Working directory [{key:"dir",prefix:"→ "}]` one line, none; `getAgentCwd` `Working directory` one line, preview.
  - Subagents: the existing `agent` kind's completion line appends ` · <elapsed>` when `timeTaken` is at least 1000 ms, through the same elapsed helper the summary line uses.

- [ ] **Step 1: Write the failing tests**

One test per group that exercises its distinctive shape, not every row:

```ts
it("shows the spill source in place of the saved name, and the name when unknown", () => {
  const args = { filename: "2026-01-01T00-00-00-000Z-abcdef.log", offset: 1, limit: 200 };
  const known = { ...plain, spillSource: () => "pnpm run typecheck" };
  const unknown = { ...plain, spillSource: () => null };
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "readSpill", args, value: "t", outcome: "success" }, known)).toBe("✓ Read output of pnpm run typecheck lines 1–201");
  expect(formatAgentTrace({ kind: "toolEnd", toolName: "readSpill", args, value: "t", outcome: "success" }, unknown)).toBe("✓ Read 2026-01-01T00-00-00-000Z-abcdef.log lines 1–201");  // Review Focus 4
});
it("shows the first line of a commit message", ...);           // "● git commit Add summary tier"
it("prints the write mode only when it is append", ...);        // "✓ Write a.md append · 812 B" vs "✓ Write a.md · 812 B"
it("accepts url or baseUrl for a fetch", ...);                  // both → "● Fetch https://x.test/doc"
it("adds elapsed time to a subagent completion", () => {
  const out = formatAgentTrace({ kind: "toolEnd", toolName: "codeAgent", value: "done", outcome: "success", timeTaken: 134000 }, plain);
  expect(out.split("\n")[0]).toBe("✓ Code finished · 2m 14s");
});
it("has a row for every tool the coordinator and code agent offer", () => {
  // A list literal of the model-facing names above; assert each is a key of the exported
  // `presentedToolNames()` (add this one export: Object.keys(TOOL_PRESENTATIONS)).
});
```

- [ ] **Step 2: Run, confirm failure. Step 3: fill the table. Step 4: run and typecheck.**

- [ ] **Step 5: Commit**

```
agentToolTrace: presentation rows for every agent tool
```

---

### Task 6: Wire the agent: `trace.agency`, the announce bridge, and the `SKIP_TRACING` list

**Files:**
- Modify: `lib/agents/agency-agent/lib/trace.agency:38-64`
- Modify: `lib/agents/agency-agent/brains/coordinator/lib/announce.agency` (if it formats completions; otherwise no change)
- Modify: `lib/stdlib/agentToolTrace.ts` (`_printAgentTrace` signature from Task 3 is what Agency calls)
- Test: `lib/agents/agency-agent/tests/` or `brains/*/tests/` (find the existing test that checks trace output, by grepping for `Tool call` or `Tool finished`; update its expectations)

**Interfaces:**
- Consumes: `_printAgentTrace(event, toolNames)` from Task 3.
- Produces: `onToolCallEnd` in `trace.agency` builds `{ kind: "toolEnd", toolName, args: data.args, timeTaken: data.timeTaken, value, outcome, provider }`. `_printAgentTrace(..., isDebug())` on every call. `SKIP_TRACING` is deleted; `whatIAmDoing` is a `silent` row (Task 5). No tool name is special-cased here: which tools show a spill source is the table's business.

- [ ] **Step 1: Find and update the existing agent trace test**

Run: `grep -rln "Tool call\|Tool finished" lib/agents tests/agency-js | head`. Whatever test asserts the old block text gets the new line text. If none exists, add a case to the nearest harness test that drives a tool call through `trace.agency` with a scripted LLM client (the brains have `tests/` directories; follow `docs/dev/agents/agent-brains.md`) asserting one `read` call prints exactly `✓ Read <file>` and nothing at start. Tests under `lib/agents` need `HOME` pointed at a scratch directory.

- [ ] **Step 2: Run it and confirm it fails**

- [ ] **Step 3: Edit `trace.agency`**

Remove `SKIP_TRACING` and the two early returns. Pass `args`, `timeTaken`, and `isDebug()` as described. Keep the Result and rejection unwrapping as is.

- [ ] **Step 4: `make`, typecheck, run the test**

Run: `make > <scratchpad>/make6.log 2>&1; tail -5 <scratchpad>/make6.log`, then `pnpm run build` (compiled agent fixtures need it), then the test.

- [ ] **Step 5: Try it by hand**

Run: `pnpm run agency agent -p "read the first 20 lines of package.json, then grep it for the word name" --verbose > <scratchpad>/manual6.log 2>&1` with a policy that approves reads (see `docs/dev/agents/approval-policies.md`; never `approve-all`). Expected lines in the log: `✓ Read package.json lines 1–21` and `✓ Grep "name" in package.json · N lines in 1 file`. This step makes one real model call; it is the only one in the plan.

- [ ] **Step 6: Commit**

```
agency agent: one summary line per tool call
```

---

### Task 7: The dev doc and the index

**Files:**
- Modify: `docs/dev/agents/tool-output.md` (rewrite the "Display rules" section; add "Guidelines" before it)
- Modify: `CLAUDE.md` (the index line for `docs/dev/agents/tool-output.md`) and the matching skill file under `.claude/skills/agency-agent-docs/` (grep for `tool-output.md`)
- Modify: `docs/dev/stdlib/spill.md` if Task 2 did not already add the `source` paragraph

- [ ] **Step 1: Write the guidelines section**

Copy the ten guidelines from the spec's "The guidelines" section into `tool-output.md` under a `## Guidelines` heading, as rules in present tense. Then rewrite `## Display rules` to describe the four presentation kinds (`tasks`, `agent`, `summary`, `silent`), the `summary` fields, the line shape, the elapsed rule, the `toolNames` debug option, and the sentence: "Adding a tool to an agent toolkit means adding a row to `TOOL_PRESENTATIONS`, or deciding in review that the generic display is fine." Do not copy the per-tool table; say the code table is the record. Keep todo, search, and subagent paragraphs. Update the example block at the top of the file to show one summary line beside the todo and search examples. Mechanism and rule only, no history.

- [ ] **Step 2: Update the index lines**

In `CLAUDE.md` the `tool-output.md` entry becomes: "Agent tool traces: the guidelines for what a tool's line shows, the four presentation kinds and the `summary` table, todo lists, search queries, subagent announcements, spill sources, and the shared sanitizing and wrapping." Mirror it in the `agency-agent-docs` skill.

- [ ] **Step 3: Read both docs once as a newcomer**, fix anything that assumes this conversation, then run `pnpm run lint:structure > <scratchpad>/lint7.log 2>&1` and `pnpm run fmt:ts <changed .ts files>`.

- [ ] **Step 4: Commit**

```
docs: tool trace display guidelines
```

Then push the branch and open a PR against `main` with the description written to a file. The description names the spec, lists the user-visible change with one before/after example, and the `onToolCallEnd.args` and `keepOutput(source)` signature changes. Stop there; the owner merges.
