# Agent names in the trace picker

**Status:** Design for the small slice chosen on 2026-10-27. It replaces the earlier key/value tag design, which is kept in git history. Implementation has not started.

## The problem

A statelog JSONL file often holds hundreds of traces from different programs. The Agency agent names its runs with `setAgentName` (`lib/agents/agency-agent/agent.agency:117`), so every one of its traces already carries an `agentName` event. The trace picker does not show that name and has no way to filter on it except the free-text `/` search, which also matches a prompt that happens to mention the word.

## What changes

Two things, both in the single-file logs viewer:

1. **An Agent column in the trace picker.** Each row shows the trace's recorded agent name. The column appears only when at least one trace in the file has a name, so files from plain programs look as they do today.
2. **An `agent:` prefix in the picker's search.** Typing `/agent:agency-agent/` lists every trace whose name starts with `agency-agent/`. Text after the first space is an ordinary text search over the same traces, so `/agent:agency-agent/coordinator timeout` finds coordinator runs that mention "timeout".

Nothing else changes. No new events, no new stdlib function, no new screens, no new keys.

## Rules

- **Which name.** The last `agentName` event in file order whose `name` is a string. This is the same rule `agency eval extract` (`lib/eval/extract.ts:126-131`) and the runs explorer (`lib/runsExplorer/mine.ts:168`) use. A trace with no such event has no name.
- **Prefix match, case-sensitive.** `agent:X` keeps a trace when its name starts with `X`. Prefix rather than exact so the list narrows as you type, and so `agent:agency-agent/` selects a whole family. A trace with no name never matches an `agent:` query. A prompt that mentions the name does not count.
- **Query grammar.** If the query starts with `agent:`, the name prefix runs to the first space or the end of the query. Whatever follows that space, with leading spaces dropped, is the text query. Agent names cannot contain spaces (`lib/statelog/agentName.ts:13`), so this split is unambiguous. A query that does not start with `agent:` is a plain text search, exactly as today.
- **Hits and the snippet.** The hits column and the "first hit" line come from the text part only. With `agent:` and no text, there is no hits column and no snippet, but the "N of M match" count still shows.
- **Opening a trace.** Enter carries only the text part of the query into the trace screen's search, because the trace screen searches rows, not names. With no text part it carries nothing, as today with an empty query.
- **Column width.** The Agent column takes the width of the longest name or the header, plus one gap cell, capped at 26 cells. Longer names are clipped with the table's existing ellipsis. The full name is visible in the trace's `agentName` event on the trace screen.
- **Column position.** Between `Started (local)` and `duration`.
- **Safety.** Names are untrusted text from the log. The table's cell painter escapes style tags and the ESC character, which is how the ask column is drawn today. Other control characters pass through, for every column; that is an existing gap in `lib/tui/paint.ts`, not one this change opens.

## Out of scope

Key/value run tags, a `setTags` stdlib function, a metadata overlay, a metadata detail view, and any change to the runs explorer or the hosted viewer. These wait until a program actually writes key/value metadata.
