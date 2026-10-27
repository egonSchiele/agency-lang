# Detailed Agent Tool Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the Agency agent's tool output match the Detailed design selected in the conversation, with readable tool headers, complete task lists, and one search query per line.

**Architecture:** Event-specific functions describe headers and rows as plain data. One renderer owns sanitizing, wrapping, rails, indentation, and styling. One print function owns empty-block suppression and spacing. The existing Agency callbacks retain visibility and Result unwrapping, and use the search-provider catalog to describe client searches. Formatting uses the current run's terminal width and color preference, with no stored relationship between tool starts and tool ends.

**Tech Stack:** TypeScript, Agency, existing ANSI formatting and wrapping helpers, Vitest, and a scripted Agency-JS integration test. No new dependencies.

**Spec:** The [Detailed output contract](#detailed-output-contract) below records the selected mockup and the implementation choices needed to build it. It makes this plan readable without the conversation or preview file.

## Global constraints

- Make Detailed the default wherever tool traces are enabled. Do not add a style picker or a new flag.
- Preserve the terminal's ordinary scrollback. Do not add a panel, cursor movement, or in-place rewriting of earlier output.
- Print a complete task list only after a successful result. Preserve task order and show every task.
- Keep tool names visible alongside descriptive labels. Provider metadata remains visible for hosted search.
- Preserve tool execution, returned values, callback registration, approval behavior, and session storage. The session change in this plan only formats existing error messages.
- Use the current run's host for terminal information. Respect `supportsColor()`, including the host's handling of `NO_COLOR` and `FORCE_COLOR`.
- Use static imports, types, objects, and arrays. Do not add dynamic imports, interfaces, Maps, Sets, or symlink machinery.
- Save test output to files. Run only the targeted Agency-JS test, never the full Agency or agent suites locally. No real model or search requests.
- Write commit messages to files and use `git commit -F`. Do not amend or force push.

## Review focus

1. A failed or malformed todo result must not print an apparently successful checklist. Covered in Task 2 and the Task 3 integration test.
2. Providers may omit search queries or return several hosted records. Missing metadata must not crash tracing or produce invented counts. Covered in Tasks 2 and 3.
3. Concurrent calls can share a tool name. Each output block must describe only its own event, without pairing starts and ends by name. Covered in Tasks 2 and 3.
4. Long text, embedded control characters, and disabled color must remain readable without hiding output or leaking styles into the answer. Covered in Tasks 1 and 2.
5. Interactive, quiet one-shot, verbose, and debug runs must apply the same trace visibility rule to ordinary and hosted tools. Covered in Task 3.

## Detailed output contract

The following are plain-text examples. In a color terminal, headers use bold text, secondary metadata and rails are dim, completed tasks have a green check and dim strikethrough text, and the active task is blue. Failed tool calls are red; session-save warnings are yellow. The markers and words convey status even without color or strikethrough.

```text
✓ Tasks updated  todoWrite
  │ 1/3 complete
  │ ✓ Verify dated independent rankings
  │ › Check availability and downloadable weights · in progress
  │ ○ Compare local hardware requirements

⌕ Web search  web_search
  │ openai-responses · 4 queries
  │ · site.anthropic.com "Fable" "5.1"
  │ · site.moonshot.ai "K3.1"
  │ · site.anthropic.com "Opus 5.5" "October"
  │ · site.blog.google "Gemini 4" "Argon"
```

The first task's text is struck through in a terminal that supports it. The example task wording is illustrative; the renderer prints the returned task text.

**Task lists**

- Recognize exactly `todoWrite`, `todoAdd`, `todoUpdate`, and `todoList`. Validate the result before using a custom display: an array whose entries have string `id`, string `text`, and status `pending`, `in_progress`, or `completed`.
- Print a heading-only start for these four operations so failed calls remain visible. Omit argument rows. On a successful valid result, print one complete block. `todoList` uses the neutral heading `Tasks  todoList`; the three mutators use `✓ Tasks updated  <toolName>`.
- Use `✓` for completed, `›` plus `· in progress` for active, and `○` for pending. The header count is completed items divided by total items.
- An empty result prints `0/0 complete` and `No tasks`. An explicitly supplied failure end event prints a named error block. The runtime currently skips end callbacks for failed calls, leaving their start heading visible. A successful result with the wrong shape uses the generic result display, with no checklist.
- Do not sort, truncate, or collapse tasks. Each successful call prints a fresh snapshot, including repeated lists. Do not add deduplication state.

**Search**

- Hosted searches print at `onLLMCallEnd`, when their records are available. Use the neutral `⌕ Web search  web_search` heading. It does not assert successful retrieval or a running search.
- Print one block per hosted `web_search` record. Keep the provider spelling reported by the record. Preserve each query's order and punctuation, including embedded quotes. Do not add JSON brackets or another layer of quotes.
- Show `1 query` or `N queries` only for a nonempty, valid query list. When queries are absent or empty, show `Queries not reported`; do not substitute `callCount` or say zero searches ran. Missing provider text becomes `Provider not reported`.
- Look up client tools through `searchProviderName` in the existing `stdlib/agents/lib/search.agency` catalog. The callback sends an explicit `clientSearch` event with the tool name, provider, and query; the formatter has no provider table. At start, print `⌕ Searching web  <toolName>` with the provider label and the single `query`. At end, print a separately named completion or failure block using the generic result preview. Do not cache the query to pair the events.
- Query text wraps and is never cut to the generic argument limit. Malformed client arguments use the generic start display. Malformed or blank hosted query entries are omitted without throwing; if none remain, use `Queries not reported`.
- Source cards, citation lists, provider-specific raw status decoding, and search timing are outside this change. A neutral hosted header must never turn into a success check merely because the LLM call ended.

**Other tools and warnings**

```text
● Tool call  readFile
  │ path: "docs/models.md"

✓ Tool finished  readFile
  │ <result preview>

✗ Tool failed  readFile
  │ <reported error>

! Session not saved
  │ <reported error and any suggested remedy>
```

- Unknown tools keep their exact names. Put each named argument on its own indented line. Generic arguments retain the current 50-code-point preview limit; generic results retain the current 100-code-point limit. Slice Unicode code points so previews cannot split surrogate pairs. Append `…` only when something was omitted. Task lists, queries, and failure messages are exempt from these limits.
- Preserve the distinction between successful, failed, and plain return values that `trace.agency` already makes. Unwrap Agency Results there before formatting; do not recognize Results by guessing at arbitrary object properties in the formatter.
- Generic plain returns use the neutral heading `· Tool returned  <toolName>`. Valid task arrays use the custom checklist for either a successful Result or a plain return; only the explicit failure outcome blocks it.
- A tool with no arguments still gets its start header. A result with no printable content still gets a completion header. Handle `null`, `undefined`, arrays, and objects without throwing while serializing a preview.
- Print each nonempty formatted block in one call, with a trailing blank line separating it from the next event or agent prose. Start and completion blocks each repeat the tool name because other calls may occur between them.
- Format both existing session-save error paths with the warning heading. Preserve the actual error text and any remedy. Do not fix the empty-directory bug or change save behavior as part of this work.

**Width and plain output**

- Use the terminal's reported columns, or 80 when width is unavailable or invalid. Wrap body text with aligned continuation indentation after the rail and status marker. At widths too small for the prefix, omit the rail and use at least one column of content; never pass a nonpositive width to the wrapper.
- Reuse `wrapText` and `visualWidth` from `lib/stdlib/layout/ansi.ts`. This feature inherits their existing character-width behavior; changing Unicode cell measurement is separate work.
- Strip incoming ANSI sequences with the existing `stripAnsi`. Normalize CRLF to LF, expand each tab to four spaces, and reuse `stripControlCharacters` from the portable `lib/utils/controlCharacters.ts` utility to replace remaining C0/C1/DEL controls with a visible replacement before applying trusted styling. The TUI imports and re-exports the same helper. Indent embedded newlines as continuation lines. Apply this one text policy to every incoming field, including tool names, provider names, argument keys, task text, queries, and errors.
- Choose `color` or `plainColor` from `lib/utils/termcolors.ts`. With color disabled, output contains no ANSI escapes. Keep the Unicode status markers and task status words; no additional ASCII-mode setting is needed.

## Workspace and existing code

Worktree root: `/Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/detailed-tool-output`.

Branch: `codex/detailed-tool-output`, created from `6038e73d4` on October 27, 2026. Run package commands from its `packages/agency-lang` directory. The original checkout contains unrelated edits; do not copy them into this branch.

Read these before implementing:

- `lib/agents/agency-agent/lib/trace.agency`: tool start/end callbacks, `_showTraces()`, `whatIAmDoing` suppression, and hosted results. Hosted output currently bypasses `_showTraces()`; Task 3 deliberately makes it obey that rule.
- `lib/agents/agency-agent/lib/utils.agency`: existing `formatArgs` and `formatToolResponse` truncation. `formatArgs` also serves debug LLM output and stays in place.
- `stdlib/agent.agency`: the `Todo` shape and complete-list returns from all four list operations.
- `stdlib/agents/lib/search.agency`: the client search names and provider labels.
- `lib/runtime/hooks.ts`: start events have arguments; end events have results but no arguments or invocation ID. No runtime event changes are needed.
- `docs/dev/runtime/host.md`, `lib/runtime/currentHost.ts`, and `lib/stdlib/layout/render.ts`: the host-access pattern.
- `docs/dev/agents/agent-sessions.md`: context for the two existing warning call sites. This plan does not change their control flow.
- `docs/misc/TESTING.md` and the scripted-client fixture `tests/agency-js/coordinator-session-tools/test.js`.

### File responsibilities

| File | Change |
| --- | --- |
| `lib/stdlib/agentToolTrace.ts` | Event descriptions, one shared renderer, and one host-aware print function. |
| `lib/stdlib/agentToolTrace.test.ts` | Formatter contracts, malformed data, wrapping, and color behavior. |
| `lib/agents/agency-agent/lib/trace.agency` | Pass events to the formatter; retain visibility and Result unwrapping. |
| `lib/agents/agency-agent/lib/utils.agency` | Remove `formatToolResponse` once its only caller moves; preserve shared helpers. |
| `lib/agents/agency-agent/lib/resume.agency` | Format the existing seed-turn save warning. |
| `lib/stdlib/agentSessions.ts` | Format the existing REPL save warning using the run's host. |
| `tests/agency-js/agent-tool-trace/{agent.agency,test.js,fixture.json}` | New deterministic integration fixture for actual callback wiring. |
| `docs/dev/agents/tool-output.md` | Record display rules and where to add another custom formatter. |
| `docs/site/agent/index.md` | Show the detailed output and explain visibility flags. |

Use `agency-lang/stdlib-lib/agentToolTrace.js` for Agency imports. The package export already permits it. Do not put a TypeScript helper beside `trace.agency`: agent staging can delete its generated JavaScript. Do not change `lib/stdlib/cli.ts`, staging, runtime hook types, or hand-edit generated files.

## Task 1: Build the common formatter and ordinary-tool display

**Files:** Create `lib/stdlib/agentToolTrace.ts` and `lib/stdlib/agentToolTrace.test.ts`.

**Interfaces:** Define and export the following types and functions. All event formatting returns a string without a trailing newline. An empty string means there is nothing to print.

```ts
type TraceOptions = { columns: number; color: boolean };
type ToolStartEvent = { kind: "toolStart"; toolName: string; args: unknown };
type ToolEndEvent = {
  kind: "toolEnd";
  toolName: string;
  value: unknown;
  outcome: "success" | "failure" | "plain";
};
type HostedSearchEvent = { kind: "hostedSearch"; result: unknown };
type ClientSearchEvent = {
  kind: "clientSearch";
  toolName: string;
  provider: string;
  query: string;
};
type SessionSaveFailureEvent = { kind: "sessionSaveFailure"; message: string };
type AgentTraceEvent =
  | ToolStartEvent
  | ToolEndEvent
  | HostedSearchEvent
  | ClientSearchEvent
  | SessionSaveFailureEvent;

function traceOptionsForHost(host: Host): TraceOptions;
function formatAgentTrace(event: AgentTraceEvent, options: TraceOptions): string;
function printAgentTrace(host: Host, event: AgentTraceEvent): void;
function _printAgentTrace(event: AgentTraceEvent): void;
```

Inside this module, define private `TraceBlock`, `TraceRow`, and `TraceSpan` types. A block contains heading spans and body rows. A row contains text spans and an optional marker; each span contains text and a semantic style such as `muted`, `completed`, or `error`. Event-specific functions produce these descriptions without ANSI codes, indentation, or wrapping. A single renderer translates them into terminal text. Keep this model limited to this feature; do not build a general layout framework.

Declare `DEFAULT_COLUMNS = 80`, `ARGUMENT_PREVIEW_LENGTH = 50`, `RESULT_PREVIEW_LENGTH = 100`, and `TAB_WIDTH = 4`. Derive indentation widths from the actual prefix strings with `visualWidth()`. Keep todo headings and task-status markers/styles in small objects. Search-provider labels come from the existing catalog so these rules each have one definition.

- [x] Add failing unit tests for the ordinary start, completion, failure, and session-warning examples. Assert exact plain strings, including rails and indentation. Cover no arguments, empty values, arrays, multiline errors, and serialization that cannot produce JSON, such as `undefined` or a circular object. Use `[unserializable value]` as the latter's explicit fallback.

```ts
it("puts each argument below its tool name", () => {
  expect(formatAgentTrace(
    { kind: "toolStart", toolName: "readFile", args: { path: "docs/models.md" } },
    { columns: 80, color: false },
  )).toBe('● Tool call  readFile\n  │ path: "docs/models.md"');
});
```

- [x] Add width/color tests: 40 and 80 columns, missing or invalid width falling back to 80, and a tiny width that still prints content. Assert plain output has no `\x1b`, styled text resets at line boundaries, embedded escape sequences in headers, metadata, keys, and bodies cannot clear the terminal, and arguments/results obey their 50/100 limits. Test that printing suppresses empty blocks and writes one complete block with exactly one blank line after it.
- [x] Run `pnpm test:run lib/stdlib/agentToolTrace.test.ts > /tmp/agency-tool-output-task1-red.log 2>&1`; confirm the new assertions fail for the missing formatter.
- [x] Implement the interfaces. `_printAgentTrace` reads `currentHost()` on its first line and delegates to `printAgentTrace`. The latter owns the one terminal write and trailing blank line. `traceOptionsForHost` reads that host's size and color preference on each call. Keep event descriptions and rendering pure, with all layout in the shared renderer. Reserve the special event branches for Task 2.
- [x] Run the same targeted test file, saving output to `/tmp/agency-tool-output-task1-green.log`; require all Task 1 tests to pass.
- [x] Commit these two files using a message file and `git commit -F`.

## Task 2: Add complete task lists and detailed search blocks

**Files:** Extend `lib/stdlib/agentToolTrace.ts` and its unit test.

**Consumes:** `AgentTraceEvent`, `TraceOptions`, and the common rows/preview helpers from Task 1.

**Produces:** Declarative block descriptions for the four todo tools, client search events, and hosted `web_search` records. All use Task 1's renderer. No new public interface or mutable cache.

- [x] Add a failing exact-output test for a three-item list with one item in each status. Assert the entire text of tasks longer than 100 characters survives, order is preserved, the count is correct, and only completed task text carries the strikethrough escape `\x1b[9m` in colored output.
- [x] Add cases for all four todo names, an empty list, all completed, several active items, failure, and malformed results. Check that task starts show a heading without argument rows, failed results have no `Tasks updated` header, and malformed results show a named generic preview. Rendering two different lists sequentially must leave each output independent.

```ts
it("does not turn a failed update into a checklist", () => {
  expect(formatAgentTrace(
    { kind: "toolEnd", toolName: "todoWrite", value: "Update refused", outcome: "failure" },
    { columns: 80, color: false },
  )).toBe("✗ Tool failed  todoWrite\n  │ Update refused");
});
```

- [x] Add hosted-search tests for the four quoted queries in the contract, a single query, long queries, embedded newlines, missing provider, missing/empty/mixed query arrays, and a record whose `raw` data reports failure. Assert the neutral header never claims success, raw data is not dumped, and query counts derive only from valid query strings. An unsupported hosted tool returns `""`.
- [x] Add client-search tests with arbitrary tool and provider labels, full query text, success, and failure. Check catalog lookup and malformed argument fallback in the callback integration test. End events must render correctly without having seen a start event.
- [x] Run the targeted unit file to `/tmp/agency-tool-output-task2-red.log`; verify the new cases fail.
- [x] Implement custom event descriptions and input validation using the shared metadata objects. Do not assemble styled strings or calculate indentation inside these functions. Keep unsupported or malformed data on the generic path where the contract calls for it.
- [x] Run the unit file to `/tmp/agency-tool-output-task2-green.log`; require all tests to pass. Commit with a message file.

## Task 3: Wire the agent callbacks and session warnings

**Files:** Modify `trace.agency`, `utils.agency`, `resume.agency`, and `agentSessions.ts`. Create the `tests/agency-js/agent-tool-trace/` fixture files listed above.

**Consumes:** `_printAgentTrace(event)` from Agency; `printAgentTrace(run.ctx.host, event)` from TypeScript that already has a run.

**Produces:** Actual agent output following the contract, with ordinary and hosted traces both controlled by `_showTraces()`.

- [x] Create a scripted integration fixture that imports the real trace module and uses its existing `setInteractive`, `setVerbose`, and `setDebug` functions. Inject an in-memory LLM client through `__setLLMClient`, following `coordinator-session-tools/test.js`. Have it issue a real `todoWrite`, an ordinary pure tool, and hosted search records. Supply stub tools with the client-search names and assert the provider labels returned by the real catalog lookup; do not call the web. Restore captured console output in `finally`, following `policy-code-diffs-late/test.js`.
- [x] Assert the actual callback output has one full todo block, a heading-only start for both a successful and a failed todo call, and no JSON return; one block per hosted record; and readable ordinary start/end blocks. Include two same-named calls in a round and assert each returned value remains attached to its own completion block. A real failed tool currently skips `onToolCallEnd` in `prompt.ts`; assert that it never prints a successful completion. Exercise the existing callback's failure branch with an explicitly injected end event from a test-only metadata callback, without changing runtime behavior.
- [x] Assert mode behavior with fresh invocations: interactive prints traces; quiet one-shot prints neither ordinary nor hosted traces; verbose one-shot prints both; debug retains its existing additional LLM diagnostics. Confirm `whatIAmDoing` remains suppressed. Configure the scripted client to throw on any unexpected request so the test cannot fall through to a real provider.
- [x] Run `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/agent-tool-trace > /tmp/agency-tool-output-task3-integration-red.log 2>&1`; confirm the fixture fails on the current output format. The build from the workspace setup must already exist.
- [x] Replace trace formatting calls with the print bridge. Keep Result unwrapping in the current end callback and translate its three existing branches into the explicit `outcome`. Apply `_showTraces()` to the hosted-results loop; preserve existing skip and debug behavior. Leave empty-block suppression and spacing to the shared print function. Remove only the now-unused `formatToolResponse` export after confirming all callers moved; leave `formatArgs` and its debug caller intact.
- [x] Replace only the output expressions in the two save-error branches. The TypeScript branch uses the host already on `run`; the Agency branch uses the bridge. Do not change error handling, return values, or session paths.
- [x] Check both warning call sites against the session-warning unit test from Task 1. The existing `agentSessions.test.ts` runs as a regression check below; do not add checkpoint or session-lifecycle test scaffolding for a text-only change.
- [x] Run `make > /tmp/agency-tool-output-task3-build.log 2>&1`, then `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/agent-tool-trace > /tmp/agency-tool-output-task3-integration-green.log 2>&1` and `pnpm test:run lib/stdlib/agentSessions.test.ts > /tmp/agency-tool-output-task3-session-green.log 2>&1`. Require success before committing with a message file.

## Task 4: Document and verify the finished display

**Files:** Create `docs/dev/agents/tool-output.md`; update `docs/site/agent/index.md`.

**Consumes:** The finished formatter and callback behavior from Tasks 1–3.

**Produces:** User-facing examples, a short maintenance guide, and recorded checks for the whole change.

- [x] Document the task markers, full task snapshots, hosted versus client search timing, and generic fallback. State that `--verbose` enables traces in one-shot mode and `--debug` retains additional diagnostics. Generate reference documentation from the new lookup docstring in the stdlib source.
- [x] Add a short developer note naming the formatter, bridge, callback file, search catalog, and shared sanitizer. Add the document to the CLAUDE and agency-agent-docs indexes. Explain how to add a custom display without changing tools or caching call state.
- [x] Run `pnpm run fmt:ts > /tmp/agency-tool-output-format.log 2>&1`. Inspect the diff and retain only formatting changes belonging to this work.
- [x] Run `pnpm run fmt:ts:check > /tmp/agency-tool-output-format-check.log 2>&1`, `pnpm run lint:structure > /tmp/agency-tool-output-lint.log 2>&1`, and `pnpm run typecheck > /tmp/agency-tool-output-typecheck.log 2>&1`. The new module is already covered by the `lib/stdlib/**/*.ts` browser lint rule; keep its imports platform-neutral.
- [x] After the last code edit, run `make > /tmp/agency-tool-output-final-build.log 2>&1`, `pnpm test:run lib/stdlib/agentToolTrace.test.ts lib/stdlib/agentSessions.test.ts > /tmp/agency-tool-output-final-unit.log 2>&1`, and `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/agent-tool-trace > /tmp/agency-tool-output-final-integration.log 2>&1`. Do not repeat unchanged successful checks merely to obtain another view of their output.
- [x] Inspect the fixture output at 40 and 80 columns with color enabled and disabled. Verify strike/check combinations, wrapped continuation indentation, metadata contrast, and separation from agent prose. Use the fixture output; do not spend a model call on this check.
- [x] Run `git diff --check > /tmp/agency-tool-output-diff-check.log 2>&1`. Check that no generated files other than the updated stdlib reference page, saved sessions, unrelated edits, or new dependencies entered the diff. Commit the documentation with a message file.

## Verification

Implemented in the task worktree. The targeted unit runs passed 48 formatter/session tests and 42 TUI regression tests, and the scripted Agency-JS fixture passed in interactive, quiet, verbose, and debug modes. The required build, TypeScript checks, formatting check, and structural/browser lint passed. Output was inspected at 40 and 80 columns with color enabled and disabled. No model or web requests were made. The full Agency suite remains for CI, as required by the repository instructions.
