# Agent tool output

```text
✓ Tasks updated  todoWrite
  │ 1/3 complete
  │ ✓ Verify rankings
  │ › Check availability · in progress
  │ ○ Compare hardware

⌕ Web search  web_search
  │ openai-responses · 1 query
  │ · site.example.com "release notes"
```

The interactive agent prints these blocks in ordinary terminal scrollback.
One-shot runs show them with `--verbose` or `--debug`. Both flags retain
the existing LLM diagnostics. `whatIAmDoing` has no separate tool block.

## Where the code lives

- `lib/stdlib/agentToolTrace.ts` describes and renders each event.
- `lib/agents/agency-agent/lib/trace.agency` checks visibility and unwraps
  Agency Results before calling `_printAgentTrace`.
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

A custom tool presentation owns both start and end behavior. Register todo
and subagent names in `TOOL_PRESENTATIONS`; provider labels select the search
presentation. Generic formatting applies only when no custom presentation
matches. Malformed custom data stays in its custom block.

To add a custom display, define both lifecycle phases and validate its input
before describing rows. A phase may return no block, as todo starts do.
Keep each event independent. End events have no invocation ID or arguments,
so pairing them with starts by tool name would mix concurrent calls.

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

Ordinary starts are blue. Plain returns and successful Results both show a
green `Tool finished` heading and dim previews. The check mark distinguishes
completions without color. Argument previews stop after 50 Unicode code
points; result and subagent-brief previews stop after 100. Failure messages,
task text, and queries stay complete.

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
