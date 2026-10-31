# Agent tool output

```text
✓ Read docs/dev/llm/mlx-local-models.md lines 460–579

● Run pnpm run typecheck
✓ Run pnpm run typecheck · 14s

✗ Grep "registers" in docs/dev/llm
  │ Tool call rejected: policy

✓ Tasks updated  todoWrite
  │ 1/3 complete
  │ ✓ Verify rankings
  │ › Check availability · in progress
  │ ○ Compare hardware

⌕ Web search  web_search
  │ openai-responses · 1 query
  │ · site.example.com "release notes"
```

The interactive agent prints these lines in ordinary terminal scrollback.
One-shot runs show them with `--verbose` or `--debug`. Both flags retain
the existing LLM diagnostics.

## Guidelines

A person watching the agent asks four questions: is it making progress, is
it doing something risky, is it on the right track, and what is taking so
long. Every line exists to answer one of them. Someone who wants every
argument has the statelog log and `--debug`.

1. **The trace answers those four questions, in that order.** What did the
   agent touch? Is this call different from the last one? Did it work? What
   is taking so long? Anything that answers none of them is noise.
2. **Show nouns, not arguments.** A line names the thing the tool acted on:
   a path, a pattern, a command, a URL, a branch. Flags are left out, with
   one exception: a flag that changes what a risky call does (`force`,
   `all`) or what a read returns (`invert`, `staged`) counts as a noun.
3. **Two consecutive calls never look identical unless they are.** The line
   carries what tells a repeat from a new call: the line range of a `read`,
   the pattern and directory of a `grep`. Without it, an agent reading a
   file in pieces looks stuck in a loop.
4. **One line per call unless the call can take long.** A tool gets a start
   line and an end line only when it can run for seconds or more. Instant
   tools get one line, printed when the call settles.
5. **Results are a count or a verdict, not text.** `12 lines in 3 files`,
   `exit 0`, `clean`, `2 errors`. The result body is for the model. Todo
   lists and search sources are the exceptions, with their own displays.
6. **Failures print in full** under the line, in red. A rejection is
   something the user did and should see confirmed.
7. **Risky calls stand out.** A write, delete, commit, or post prints its
   noun on a start line even when it is instant.
8. **Elapsed time appears only from one second**, only on the end line of a
   two-line tool, as `14s` or `2m 14s`.
9. **A tool nobody has thought about falls back to the generic display**:
   every argument at start, a preview at end, with the tool name in the
   heading since it has no other label. Tools whose names are not known
   when the code is written (MCP tools, `learned_*` tools, generated
   tools, Claude skill tools) use it by design.
10. **Hand-written display code is the last resort.** A tool gets a custom
    describe function only when its output has a shape the summary row
    cannot express. Today those are todo lists, searches, and subagents.

Adding a tool to an agent toolkit means adding a row to
`TOOL_PRESENTATIONS` in `lib/stdlib/agentToolTrace.ts`. The test
`brains/coordinator/tests/toolPresentations.agency` walks every tool the
coordinator and the code agent offer and fails on a name with no row.

A one-line tool that raises an interrupt shows the approval prompt before
its line. The prompt names the path, so no trace line precedes it.

## Where the code lives

- `lib/stdlib/agentToolTrace.ts` describes and renders each event.
- `lib/agents/agency-agent/lib/trace.agency` checks visibility and unwraps
  Agency Results before calling `_printAgentTrace`. It names no tool; which
  tools print, and how, is the renderer's table.
- `lib/utils/formatElapsed.ts` prints a duration (`47s`, `5m 17s`); the eval
  status board shares it.
- `stdlib/agents/lib/search.agency` owns the search-provider catalog and
  exports `searchProviderName` for looking up a tool's provider label.
- `brains/coordinator/lib/announce.agency`, under the agent directory, sends
  subagent announcements through the same renderer and visibility rule.
- `lib/utils/controlCharacters.ts` strips control characters for both the
  trace renderer and the TUI. The TUI re-exports the shared helper.
- `lib/agents/agency-agent/lib/resume.agency` and
  `lib/stdlib/agentSessions.ts` use the same renderer for save warnings.

The TypeScript helper belongs in `lib/stdlib` so the agent can import it
through `agency-lang/stdlib-lib/agentToolTrace.js`. Agent staging removes
emitted JavaScript beside Agency sources when it has no corresponding
Agency or handwritten JavaScript source.

## Descriptions and rendering

Event-specific functions return a private `TraceBlock` description.
It contains heading spans and rows, with semantic styles and optional
markers. The shared renderer owns sanitizing, wrapping, indentation,
rails, and ANSI styling. Tool-specific functions do not calculate widths
or emit ANSI codes.

A presentation owns both start and end behavior. `TOOL_PRESENTATIONS` maps
a tool's model-facing name (after any `.rename()`) to one of four kinds:
`tasks` and `agent` are the hand-written todo and subagent displays,
`silent` prints nothing (`question`, `saveDraft`, `whatIAmDoing`), and
`summary` is the one most tools use. Provider labels select the search
presentation. Generic formatting applies only when no presentation matches.
Malformed custom data stays in its custom block.

A `summary` row is data: a `label`, a `show` function that builds the parts
after the label from the call's arguments, `twoLines`, and a `result`
summary. `show` is a function and not a format language because the forms
kept multiplying; its vocabulary is a few exported helpers (`text`,
`filePath`, `lineRange`, `flag`, `prefixed`, `spillOutput`, `urlWithPath`),
each tested once, and every value is cut to its first line. `result` is
`none`, `verdict`, `preview`, a count with a noun, `exitCode` (red when not
0, output under the line), or a custom summarizer that can also say the
result counts as a failure. One function, `describeSummary`, holds every
branch; rows hold no code beyond their `show` and the odd summarizer.

The line is `<mark> <label> <parts> · <result> · <elapsed>`, with separators
only between present pieces. A two-line row prints `● <label> <parts>` in
blue at start and the marked line at end. The end event carries the call's
arguments (`onToolCallEnd.args`) and its duration, which is what lets a line
be built when the call settles. End events have no invocation ID, so the
renderer never pairs them with starts in code; a reader pairs them by eye.

Summary lines carry no tool name. Under `--debug`, `trace.agency` passes
`toolNames` and the registered name is appended in dim text, which is how a
reader finds the call in the log. The generic, todo, search, and subagent
headings keep the name always, since it is their only label.

`readSpill` and `grepSpill` show `output of <source>` in place of the saved
output's generated name, through the `spillSource` lookup in
`TraceOptions`. `_printAgentTrace` supplies it from the current run's store;
`formatAgentTrace` stays pure and tests pass a fake. A name the store does
not know prints as is.

Command output under a line (a failed `safeBash`, a nonzero `exec`) is
stderr when there is any, else stdout. A spill notice is cut to its first
line, which carries the size and exit code; the rest is written for the
model.

`printAgentTrace` reads width and color preferences from the supplied host
on each call. It prints each nonempty block in one write with a blank line
after it. The Agency bridge reads `currentHost()` before delegating.

## Display rules

The four todo operations print no start block. A successful result containing
a valid list prints
every task in its original order, including repeated snapshots.
Completed tasks have a green check and dim strikethrough text. Active tasks
use blue text and an explicit status label. Plain output keeps the markers
and words. Empty lists show `0/0 complete` and `No tasks`. Failures show a named
`Tasks failed` block; malformed returned lists show `Task result`.

Hosted searches print when `onLLMCallEnd` receives their records. Their
neutral heading does not claim successful retrieval. Each nonblank query
string gets its own row. Missing queries show `Queries not reported`, and
missing provider text shows `Provider not reported`. Raw provider results
are not interpreted or printed.

Hosted and client searches share the `Web search` heading and query/source
layout. `trace.agency` passes the provider label from
`searchProviderName(toolName)` on both start and end events. Unknown tools
get `null` from that lookup.

Client starts are blue with `⌕`; successful completions are green with `✓`;
failures are red with `✗`. Hosted reports remain neutral because their
records have no success status. Returned sources use the normalized
`title` and `url` fields. Show up to five sources and a count of any remaining
ones. A client result of `[]` means `0 sources`; missing or malformed sources
mean `Sources not reported`. A hosted record with no sources omits that
section, since absence does not establish zero results.

The coordinator's subagent functions call `announce` with their tool name.
It sends an `agentStart` event containing the brief, including for direct
calls from code. Their registered presentation suppresses generic tool starts
and supplies a named completion or failure. This keeps one announcement per
dispatch. Announcements obey the same visibility flags as other traces.

Generic starts are blue. Plain returns and successful Results both show a
green `Tool finished` heading and dim previews. The check mark distinguishes
completions without color. Generic argument previews stop after 50 Unicode
code points; result and subagent-brief previews stop after 100. Summary
parts, failure messages, task text, and queries stay complete. A subagent's
completion line carries its elapsed time from one second.

The runtime emits `onToolCallEnd` after settled success, failure, or rejection.
Paused calls emit no completion until they settle. Cancellation, guard aborts,
and calls refused before starting emit no end event. The callback unwraps
Agency Results and recognizes native rejection responses before formatting.

All incoming text passes through one sanitizer before trusted styling.
It strips ANSI sequences, normalizes CRLF, expands tabs to four spaces, and
replaces remaining control characters. Embedded newlines receive the same
continuation indentation as wrapped lines.

The renderer uses the existing `wrapText` and `visualWidth` helpers. It
inherits their JavaScript character-width measurement, including its limits
for emoji and wide characters. Missing or invalid terminal widths use 80
columns. Very narrow terminals omit decorative prefixes to preserve content.
