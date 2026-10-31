# Review: agent tool trace display (spec and plan)

Date: 2026-10-31.

- Spec: `docs/superpowers/specs/2026-10-31-agent-tool-trace-display-design.md`
- Plan: `docs/superpowers/plans/2026-10-31-agent-tool-trace-display.md`

I checked the claims in both documents against the code in this worktree. Paths are relative to `packages/agency-lang`. The design is sound and most of the plan's facts hold. Five problems should be fixed before anyone executes the plan, because each one either breaks a stated goal or makes a task's tests wrong. After those come ten smaller fixes, one design suggestion, and a list of what I checked and found correct.

## Must fix before executing

### 1. Hiding the tool name breaks about 25 assertions and leaves unknown tools nameless

Task 3 makes `toolHeading` append the dim tool name only when `toolNames` is true. The plan says this changes "the one existing assertion at `agentToolTrace.test.ts:54`". It changes many more. `toolHeading` builds the heading for every display: todo lists, web searches, subagents, and the generic fallback. These assertions in `lib/stdlib/agentToolTrace.test.ts` all include the name today:

- lines 27, 33, 39 (`→ Research  researchAgent`, `✓ Research finished  researchAgent`)
- lines 79, 85, 120, 135, 138, 271, 298, 326, 369 (`✓ Web search  catalog_search`)
- lines 207, 215, 225, 234, 248 (`✓ Tasks updated  todoWrite`)
- lines 420, 425, 428, 440, 442, 460, 480, 486, 543 (`✓ Tool finished  custom`)

`tests/agency-js/agent-tool-trace/test.js:109-130` asserts the same suffix end to end.

So two of the plan's global constraints contradict Task 3. The todo, search, and subagent displays would not stay "byte for byte". The existing tests would not "keep passing unchanged".

The second problem matters more to users. The generic display has no label of its own. Its heading is "● Tool call" plus the tool name. Task 3's test expects `"● Tool call\n  │ a: 1"` for an unknown tool. With the name gone, nothing on the screen says which tool ran. That covers every tool with no row, including all the ones that can never have a row: MCP tools, `learned_*` tools, generated tools, and anything added later. Guideline 9 says a reviewer should notice a tool on the generic display. Nobody can notice it if the line does not name the tool.

Fix: drop the name only on `summary` rows, where the label replaces it. Keep it on the generic heading, where it is the only label. Then decide separately whether the todo, search, and subagent headings keep it. Keeping them is the smaller change, and the plan's "byte for byte" constraint then holds. If the owner wants those dropped too, the plan should list every assertion that changes.

### 2. File tools drop `dir`, so two different files can print the same line

`read`, `write`, and `edit` all take `filename` and `dir` (`stdlib/index.agency:199-205`, `:234-240`, `stdlib/fs.agency:54`). The spec's rows show `filename` only. These two calls print the same line, `✓ Read README.md`:

```text
read(filename: "README.md", dir: "packages/agency-lang")
read(filename: "README.md", dir: "packages/examples")
```

The spec names this as its first anti-goal: "a line that looks the same for two different calls". Fix: show `dir` joined to `filename` when `dir` is set and is not `"."`. This is a display-only join, so `packages/examples/README.md`. `ls`, `glob`, and `grep` already show their directory, so only the three filename tools need it.

### 3. The line range is off by one, and wrong when `offset` is 0

`sliceLines` (`lib/stdlib/builtins.ts:188-202`) treats `offset` as the 1-based first line and `limit` as a line count, with 0 meaning "not set" for both. So `offset: 460, limit: 120` returns lines 460 to 579, and `offset: 0, limit: 120` returns lines 1 to 120.

The spec's rule, `lines {offset}–{offset+limit}`, prints `lines 460–580` for the first call and `lines 0–120` for the second. The spec's own example (`lines 460–580`), Task 3's test, and Task 5's test (`lines 1–201` for `offset: 1, limit: 200`) all inherit the error.

The correct rule:

- start = `offset` when it is above 0, else 1
- end = start + `limit` − 1 when `limit` is above 0, else "end"
- print nothing when both are 0

That gives `lines 460–579`, `lines 1–120`, `lines 1–200`, and `lines 460–end`. The same rule applies to `readSpill`, which shares `sliceLines` (`lib/stdlib/spill.ts:37`).

### 4. `exec` and `agencyCli` print a green check for a failed command

`exec` returns a plain `ExecResult`, not a `Result` (`stdlib/shell.agency:85-95`). `agencyCli` returns one too (`lib/agents/agency-agent/brains/coordinator/subagents/code.agency:59-91`). A nonzero exit is therefore not a failure. `trace.agency` sends it with `outcome: "plain"`, and the summary display would print:

```text
✓ Run git log --oneline -5 · exit 128
```

That is the spec's third anti-goal: "a failure hidden behind a tidy count". Fix: the `exitCode` summarizer turns the mark red when the exit code is not 0, the way Task 4's `failsWhen` already does for typecheck errors. It also prints `stderr` under the line, using the same rule as `safeBash` (see item 8). The plan should also say that the summary display treats `outcome: "plain"` as a success. Today it only mentions success and failure.

### 5. Task 1's test probably reads back an empty list

The test records calls in an Agency global (`let seen` plus `callback("onToolCallEnd")`). It then reads them from JavaScript with an exported `seenCalls()` after the run ends. No neighbouring test does this. I expect that call to see fresh globals and return `[]`, though I did not run it to confirm.

The test the plan says to copy, `tests/agency-js/block-callback-tool-resume/test.js:96-121`, does something different. It passes JavaScript callbacks to `main({ callbacks })` and to `respondToInterrupts(..., { metadata: { callbacks } })`. It records into JavaScript arrays and writes them to `__result.json`, which is compared against `fixture.json`. It already pauses on an interrupt and resumes.

Fix: extend that test instead of creating a new one. Give `interruptTool` a parameter. Pass `{ name: "FOO" }` in the scripted tool call. Record `args` in the existing `onToolCallEnd` capture, and add the expected value to `fixture.json`. The spec already says "extend the nearest one". The plan should follow it.

## Should fix

### 6. Two result shapes break the count summarizers

- `grep` with `filesOnly: true` returns a list of path strings, not match objects (`lib/stdlib/shell.ts:562`). `summarizeGrep` counts distinct `file` fields, so it would print "0 lines in 0 files" or similar. The `filesOnly` case should print `3 files`.
- `grepSpill` with `morePatterns` returns `{ pattern, matches }[]` (`lib/stdlib/spill.ts:59-72`). The `{ count: "lines" }` summarizer would count patterns, not lines. It needs a small custom summarizer that sums `matches.length`.

A related optional fix concerns truncation. A `grep` that hits `maxResults` (default 200) prints a tidy `200 lines`. Printing `200+ lines` when the count equals the cap would keep the line honest. Doing it needs the default, which lives in the Agency signature, so I'd leave it to the owner.

### 7. `typecheck` has no filename to show

`typecheck(source, ignoreCodes, dir, strict)` takes source text, not a path (`stdlib/agency.agency:813-818`). `typecheckFile` takes a path, but no toolkit offers it (`stdlib/agents/lib/toolkits.agency:310`). The spec's example `✓ Typecheck foo.agency · clean` cannot happen. The line will be `✓ Typecheck · clean`. Task 4's tests use `Typecheck f.agency` without saying which argument supplies the name. Fix the spec row and the tests.

### 8. The `safeBash` failure detail needs a rule for stdout and for a spilled stderr

The plan prints `stderr` under the line. Two common cases go wrong:

- Many tools write their errors to stdout. `tsc` does, so `pnpm run typecheck` fails with the errors in stdout and only pnpm's one-line `ELIFECYCLE` message in stderr. The user sees `✗ Run pnpm run typecheck · exit 2` and no errors.
- When stderr is long, `keepOutput` has already replaced it with the model's notice (`stdlib/safeBash/actions.agency:151`). That notice is up to about 2000 characters. It includes preview lines and the sentence "To read it, use the readSpill tool…", which is meant for the model. The user would see all of it.

Proposed rule: show stderr when it is not empty, otherwise stdout. When the text is a spill notice, show only its first line, which carries the line count, the size, and the exit code. This is the owner's call. Task 4 should test both cases.

### 9. Long and multi-line commands wrap; they are not cut

The spec says a `safeBash` command "is cut at the terminal width by the existing wrapper". `renderLines` (`lib/stdlib/agentToolTrace.ts`) calls `wrapText`, which wraps. It does not cut. `sanitize` keeps newlines. A heredoc command of 30 lines would print 30 lines at start and 30 more at end. Fix: show the first line of the command, add `…` when there is more, and cut it to the width left on the heading line. `gitCommit`'s `firstLine` option in Task 5 already does half of this, so make it the rule for any shown argument.

### 10. The echo arm's spill source differs from the spec

The spec says the shell path passes "the command it ran". Task 2 Step 5 says the `echo` arm passes `content`, which is the echoed text. The original `command` is in scope where the `match` runs (`stdlib/safeBash.agency:886-940`).

The simplest version passes `command` to every path: the echo arm, `runAgency`, `cliOutcome`, and `runBash`. That drops the `"agency " + args.join(" ")` reconstruction. It also makes the `readSpill` line name exactly what the `safeBash` line showed: `● Run pnpm run typecheck`, then `✓ Read output of pnpm run typecheck`. `runBash` receives the narrowed text (`command as text`), which can differ from what the user saw on the trace line.

### 11. Look up the spill source in the renderer, not in `trace.agency`

Task 6 has `trace.agency` check whether the tool is named `readSpill` or `grepSpill`, call `_spillSource`, and put the result on the event. That duplicates the table's knowledge in a second place. It also misses a renamed reader, and the store already handles renames by matching on module and registered name (`lib/runtime/toolOutputStore.ts`, `isSpillReader`).

`_printAgentTrace` is TypeScript, and it already reaches the host through `currentHost()`. It can reach the run through `currentRun()`, the same way `_spillSource` would. So:

- `_printAgentTrace` passes `lookupSpillSource: (name) => findOutputSource(currentRun(), name)` in `TraceOptions`.
- A `{ spillName: "filename" }` argument calls that lookup.
- `formatAgentTrace` stays pure. A test passes a fake lookup.
- `trace.agency` gains nothing and `ToolEndEvent` gains no `spillSource` field. `_spillSource` in `lib/stdlib/spill.ts` is not needed.

### 12. The coverage test cannot fail when a tool is added

Task 5's test checks a hand-written list of names against the table. When someone adds a tool to a toolkit, the list does not change, so the test still passes. Derive the list from the real tool arrays instead. `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency:142` already walks `mainAgentTools` by name. An Agency test can walk `mainAgentTools` and `buildTools()` from `std::agents/coding`, and check each `.name` against `presentedToolNames()`, with an explicit list of names allowed on the generic display.

Two gaps the derived test would catch:

- `turnTools` (`coordinator.agency:118-128`) adds `learnTools` and `elapsedTime`, which no table in the spec mentions.
- MCP tools, `learned_*` tools, generated tools, and Claude skill tools have names nobody knows at build time. The spec should say these use the generic display by design. Item 1 is what keeps that display usable.

### 13. Some dropped flags are the risk or the difference

Guideline 2 says to leave flags out. Guidelines 3 and 7 need some of them:

- `gitCheckout(force: true)`, `gitBranchDelete(force: true)`, and `gitAdd(all: true)`. `● git branch -d feature` and a forced delete look the same, and `● git add` with `all: true` shows nothing at all.
- `grep` with `invert: true` or `ignoreCase: true`. Two greps of the same pattern, one inverted, print identical lines.

Suggested wording for guideline 2: "A flag that changes what a risky call does, or what a read returns, counts as a noun." The `{ flag, text }` argument form already supports this. The owner should decide.

### 14. Task 2's "pass `{}`" fallback is not needed

Task 2 Step 4 says the rejection and failure paths at `prompt.ts:962` and `:992` should "pass `{}` if it is not on that record". `InvokedCall` (`prompt.ts:940-948`) has `toolCall` but not `namedArgs`. It is built at `prompt.ts:1149` from a record that does have `namedArgs`. Add `namedArgs` to `InvokedCall` and pass it. A `{}` would quietly give those spills a source of the bare tool name.

### 15. Task 6 should name the existing end-to-end trace test

`tests/agency-js/agent-tool-trace/` already drives `trace.agency` with a scripted client. It covers an ordinary tool, a wrapped success, a failure, searches, a subagent, and the `whatIAmDoing` suppression (`test.js:109-159`). Task 6 says to grep for such a test and, if there is none, to build one in a brain's `tests/` folder. Name this one, update its assertions for the new lines, and add the `read` case there.

## Minor

- `fetchMarkdown`'s parameter is `baseUrl | url` (`stdlib/http.agency:146`). `toolArgumentsFor` canonicalizes aliases before any hook sees the arguments (`lib/runtime/toolInvocation.ts:288`), so `args` always has `baseUrl` and never `url`. Drop `{ key: "url" }` and the "accepts url or baseUrl" test, which tests an input the runtime never sends.
- `ghPrReview`'s `event` is `COMMENT`, `APPROVE`, or `REQUEST_CHANGES` (`stdlib/github.agency:702`). The spec's example prints `request changes`. Either add a small mapping or change the example to the raw value.
- `remember` makes a model call to pull facts out of the text (`stdlib/memory.agency:187-190`), so it is not instant and it costs money. Under guidelines 4 and 7 it should be a two-line tool.
- A one-line tool that raises an interrupt now shows the approval prompt with no trace line before it. The spec covers this for `write` and `edit`. It also applies to `read`, `ls`, `grep`, and `glob` when no policy pre-approves them. That is fine, because the prompt names the path, but the dev doc should state it.
- The skill and docs tools are `read.partial(dir: …).rename(…)` (`stdlib/skills.agency:279`), so their argument is `filename`. It is required, so the spec's "`list` when none" never happens.
- The plan hard-codes the commit trailer `Co-Authored-By: Claude Fable 5.1`. The session that executes the plan should use the attribution its own instructions give.

## A design suggestion: make `show` a function

By the end of Task 5, `SummaryArgument` has eight forms: `key`, `prefix`, `limit`, `only`, `firstLine`, `flag`, `range`, and `spillName`. Items 2, 9, and 13 would add more, such as joining `dir` and `filename`. Each form is a feature of a small interpreter that needs its own code and tests. The spec allows a function per tool in place of the format language.

I suggest keeping `label`, `twoLines`, and `result` as data, and making `show` a function built from a few shared helpers:

```ts
read:      { kind: "summary", label: "Read",       twoLines: false, result: "none",
             show: (a) => [filePath(a), lineRange(a)] },
gitCommit: { kind: "summary", label: "git commit", twoLines: true,  result: "none",
             show: (a) => [firstLine(a.message)] },
ghPrGet:   { kind: "summary", label: "gh pr get",  twoLines: true,  result: "none",
             show: (a) => [pr(a)] },
```

Each row stays on one or two lines, and you can still read the table as data. The helpers (`filePath`, `lineRange`, `firstLine`, `pr`, `flag`) each get one test, and the rows need no interpreter. The plan's Review Focus item 2 (numbers print as digits, arrays join with spaces) becomes the job of one `text(value)` helper.

## Scope question: the spill source in the tool loop

The spill source touches three runtime files (`toolOutputStore.ts`, `toolInvocation.ts`, `prompt.ts`), the `keepOutput` signature, and the notice the model reads. The `safeBash` half is cheap and covers the common case: the coordinator and code agent reading back a long command's output. The tool-loop half only matters inside subagents that set `spillToolResultsOver`. Without it, those `readSpill` lines fall back to the raw name, which Review Focus 4 already handles.

If the owner wants a smaller change, the tool-loop half can be cut and done later. I'm raising this once and won't bring it up again.

## Checked and correct

- **Arguments after a resume.** `namedArgs` is rebuilt from the saved tool call on every pass by `gateInputFor` (`lib/runtime/prompt.ts:1415-1420`, called at `:1524`). The end hook at `:1683-1693` is in the same closure as the start hook at `:1588-1593`. Passing `args: namedArgs` works on a resumed run, so the fallback in Task 1 Step 3 is not needed.
- **Table keys.** `toolName` is `handler.name`, the model-facing name. The renamed names the spec lists match `stdlib/agents/lib/toolkits.agency:79-89` and `:274-276`. `superpowersSkill`, `coordinator_skills`, and `skills_<agent>` use fixed names, not names derived from a path.
- **`keepOutput` callers.** There are exactly the sites the plan lists: `stdlib/safeBash.agency:939, 955, 961, 963` and `stdlib/safeBash/actions.agency:144, 151`, plus the module doc example at `stdlib/spill.agency:35`.
- **Parameter names in Task 5.** Every git tool and every GitHub tool matches its signature in `stdlib/git.agency` and `stdlib/github.agency`. That includes `target` on `gitCheckout`, `ref2` and `staged` on `gitDiff`, `number` on the `gh` tools, and `labels` on `ghIssueLabel`. The same holds for `exec`'s `command` and `args`, `generateImageFile`'s `path`, `learnSkill`'s and `writeToolFor`'s `name`, and `setAgentCwd`'s `dir`.
- **Result shapes.** `TypeCheckReport` is `{ errors, warnings }` (`stdlib/agency.agency:149`). `TestReport` is `{ pass, cases }` (`:468`). The `safeBash` failure JSON is `{ command, exitCode, stderr, stdout }` (`stdlib/safeBash/actions.agency:146-153`).
- **Notice text.** Nothing outside `lib/runtime/toolOutputStore.ts` matches the string "Output too long to return", so changing the notice's first line breaks no test that matches on it.
- **`--debug`.** `isDebug()` in `trace.agency` reads `AGENT_DEBUG`, which `agent.agency:76` sets for `--debug`.
- **Checkpoints.** The global store's schema is `z.record(z.string(), z.record(z.string(), z.any()))` (`lib/runtime/state/schemas.ts:98`), so a new `source` field on a saved entry needs no schema change.
