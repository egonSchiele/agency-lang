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
- `lib/agents/agency-agent/lib/resume.agency` and
  `lib/stdlib/agentSessions.ts` use the same renderer for save warnings.
- `lib/stdlib/agentToolTrace.test.ts` covers the formatting contract.
- `tests/agency-js/agent-tool-trace/` exercises the real callbacks with a
  scripted LLM client. It saves captured output in `test-output/trace.json`.

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

To add a custom display, validate its input and return a block description
from `describeEvent`. Add tests for valid data and the generic fallback.
Keep each event independent. End events have no invocation ID or arguments,
so pairing them with starts by tool name would mix concurrent calls.

`printAgentTrace` reads width and color preferences from the supplied host
on each call. It prints each nonempty block in one write with a blank line
after it. The Agency bridge reads `currentHost()` before delegating.

## Display rules

The four todo operations suppress their start block. A valid returned list
prints every task in its original order, including repeated snapshots.
Completed tasks have a green check and dim strikethrough text. Active tasks
use blue text and an explicit status label. Plain output keeps the markers
and words. Empty lists show `0/0 complete` and `No tasks`.

Hosted searches print when `onLLMCallEnd` receives their records. Their
neutral heading does not claim successful retrieval. Each nonblank query
string gets its own row. Missing queries show `Queries not reported`, and
missing provider text shows `Provider not reported`. Raw provider results
are not interpreted or printed.

Tavily and Brave client tools print their full query at start. Their end
events use the ordinary result display. Unknown tools and malformed custom
results also use that display. Argument previews stop after 50 characters;
result previews stop after 100. Failures, task text, and queries stay complete.

Only an explicit failure event produces a failure heading. The runtime
currently skips `onToolCallEnd` for a tool returning a failure. The fixture
checks that such a call has no successful completion and injects a separate
failure event to cover the callback's Result unwrapping.

All incoming text passes through one sanitizer before trusted styling.
It strips ANSI sequences, normalizes CRLF, expands tabs to four spaces, and
replaces remaining control characters. Embedded newlines receive the same
continuation indentation as wrapped lines.

The renderer uses the existing `wrapText` and `visualWidth` helpers. It
inherits their JavaScript character-width measurement, including its limits
for emoji and wide characters. Missing or invalid terminal widths use 80
columns. Very narrow terminals omit decorative prefixes to preserve content.

## Checks

Save output when running tests:

```bash
pnpm test:run lib/stdlib/agentToolTrace.test.ts lib/stdlib/agentSessions.test.ts > /tmp/agent-tool-output-unit.log 2>&1
make > /tmp/agent-tool-output-build.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/agent-tool-trace > /tmp/agent-tool-output-integration.log 2>&1
```

The fixture uses no model or web requests.
