# Agent tool output

```text
● Reading  docs/models.md · lines 460–579

● Searching  "registers|plugin|local serve" in docs/models.md

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
One-shot runs show them with `--verbose` or `--debug`. Normal output and
`--verbose` use compact tool summaries. `--debug` shows full supplied
arguments and results for ordinary tools, including the compact tools below.
Todos, web searches, and subagent announcements keep their custom displays
in debug mode. Both flags retain the existing LLM diagnostics.
`whatIAmDoing` has no separate tool block.

## What a tool display should tell you

Show what the agent requested and enough detail to distinguish repeated
calls. Two reads of one file must show their different ranges. Two searches
must show their patterns and scopes. Keep those values complete and let the
renderer wrap them; a truncated filename or pattern can hide the difference.

A quick inspection needs one start block. Its successful end adds no useful
information when it only repeats the tool name or previews file contents.
When it takes at least one second, show a completion with the elapsed time
and no content preview. Always show a reported failure or rejection.
Commands retain their completion output because it can explain what ran.

Describe the supplied arguments. The trace does not resolve paths against
the agent working directory or consult the filesystem. A range is the range
requested, not proof that every line existed. Compact searches omit case
sensitivity and result caps; debug output retains all supplied arguments.

## Where the code lives

- `lib/stdlib/agentToolTrace.ts` describes and renders each event.
- `lib/stdlib/agentToolSummary.ts` describes the compact call arguments.
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

A custom tool presentation owns both start and end behavior. Register tool
names in `TOOL_PRESENTATIONS`; provider labels select the search
presentation. The compact displays extend that registry and use the same
renderer. Generic formatting applies to tools without a custom presentation
and to ordinary tools in debug mode. Malformed todo and search data stays in
its custom block. Compact starts fall back to generic argument rows when
their arguments cannot be summarized.

```ts
read: { kind: "summary", summary: readSummary, label: "Reading", result: "hide" }
```

Each summary entry chooses an argument formatter, a heading, and a result
policy. `hide` suppresses fast successful completions. `preview` keeps the
generic result display. `command` also interprets the command's exit code.
Every policy shows failures. Each entry references its formatter function
directly. Reuse a formatter when another tool has the same arguments; add
a function in `agentToolSummary.ts` when it needs a different description.
There is no separate formatter-name list or dispatch switch to update.

A formatter receives an argument object and the tool name. It returns
`{ text, details }`, or `null` to use generic argument rows. The shared
caller handles non-object arguments and debug output before invoking it.

To add a custom display, define both lifecycle phases and validate its input
before describing rows. A phase may return no block, as todo starts do.
Keep each event independent. End events have no invocation ID or arguments,
so pairing them with starts by tool name would mix concurrent calls.
Elapsed time comes from the callback's existing `timeTaken` value. There
are no timers, cached starts, or changes to the runtime callback API.

`printAgentTrace` reads width and color preferences from the supplied host
on each call. It prints each nonempty block in one write with a blank line
after it. The Agency bridge reads `currentHost()` before delegating.

## Compact tool inventory

These inspection tools print a compact start. They suppress successful ends
under one second and show only duration for longer successful calls. Failure
messages remain visible and complete.

| Tools | Start details |
| --- | --- |
| `read`, `readSpill` | Filename, supplied directory where applicable, and requested line range. `readSpill` names saved output, not a disk file. |
| `grep` | Pattern, requested `path` or its `dir` alias, unusual matching modes, and raw flags other than `i`. |
| `grepSpill` | Saved-output filename, the first pattern and every `morePatterns` entry. |
| `ls` | Directory and recursive mode when requested. |
| `glob` | Pattern and directory. |
| `agencyGuide`, `agencyCliDocs`, `agencyDiagnostics`, `agencyStdlib`, `agencyAgent` | Named documentation collection, filename, and requested range. These are renamed file readers. |

For reads, `offset` is a 1-based starting line; zero means the beginning.
`limit` is the maximum number of lines; zero means the remainder. A request
with offset 460 and limit 120 shows `lines 460–579`, an inclusive range.
An open-ended read shows `lines 460–end`. A whole-file read needs no range.
These describe the request, without inferring actual line counts.

For grep, preserve whole-word matching, files-only output, inverted matching,
and raw non-`i` flags. Keep unsupported flags visible so a corrected retry
looks different. Compact grep omits case sensitivity. Compact `grep`,
`grepSpill`, `ls`, and `glob` omit result caps.
`grep` can return matching-line objects or filenames. `grepSpill` can return
separate groups for several patterns. Listing and search results have no
explicit truncation flag, so these displays do not claim total counts or
truncation. The documentation tools have no separate search or list API;
filesystem searches use `grep`, `glob`, and `ls`.

These tools also have compact starts, but retain generic result previews
and visible failures:

| Tools | Start details and completion rules |
| --- | --- |
| `write` | Filename, directory, and write mode, without the file body. Its successful Result contains `true`, not a description of the written file. |
| `edit` | Filename, directory, and number of requested edits, without replacement text. Its successful result contains the filename, edit count, and replacement count. |
| `safeBash` | Command and supplied working directory. A nonzero exit is a failure Result; long output may be a preview naming saved output. |
| `exec`, `agencyCli` | Executable and arguments, or Agency CLI arguments, plus the supplied working directory where applicable. A valid result with `stdout`, `stderr`, and `exitCode` displays the exit code. A nonzero code must not receive a green success heading. |

Keep an explicit command `cwd: "."` visible. Omitting `cwd` can use the
agent's working directory, which may differ from the process directory.

## Existing custom displays

The four todo operations print no start block. A successful result containing
a valid list prints every task in its original order, including repeated snapshots.
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

## Generic tools and debug output

The remaining tools keep generic formatting for now:

- Git and GitHub reads and writes, Agency checks (`typecheck`, `parseAST`,
  `testFile`), and working-directory tools.
- Web fetches, Wikipedia, memory, saved drafts, elapsed time, and questions.
- Image generation and viewing; preset and model-option management.
- Learning (`learnTools`, `learnSkill`, `writeToolFor`), skill loaders,
  learned tools, session-generated tools, and configured MCP tools.

The tool bundles live in `stdlib/agents/lib/toolkits.agency`. The coordinator
adds tools in `brains/coordinator/coordinator.agency`, and subagents add their
own bundles. MCP and learned tools make the list open-ended. Their result
contracts vary: a successful typecheck Result can contain diagnostics, and
some management tools return a failure explanation as plain text. A generic
completion reports that a call settled; it does not establish that the
user's task succeeded. Add a custom result interpretation only after checking
that tool's contract.

Ordinary starts are blue. Generic plain returns and successful Results show
a green `Tool finished` heading and dim previews, except for the command
exit-code handling above. The check mark distinguishes completions without
color. Outside debug mode, generic argument previews stop after 50 Unicode
code points and result previews after 100. Debug removes those preview limits
and prints the full supplied arguments and results through the same
sanitizer and wrapper. It does not add arguments that the model did not
supply. Subagent briefs retain their 100-code-point preview. Failure messages,
task text, and queries stay complete.

## Lifecycle and terminal rendering

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
