---
name: Observability
description: How to enable Agency's structured logging for events like node entry, LLM calls, tool calls, and interrupts, and how to view the resulting JSONL logs.
---

# Observability

Agency records prompts, tool calls, interrupts and timings in structured logs. The interactive log viewer needs a terminal with at least 100 columns and truecolor support.

## Enabling observability

In your `agency.json`, set `observability: true` and configure at least one sink:

```json
{
  "observability": true,
  "log": {
    "host": "stdout",
    "logFile": "logs.jsonl"
  }
}
```

Sinks:

- `host: "stdout"` — prints logs to `console.log`.
- `logFile: "<path>"` — appends logs to the given file. The parent directory is created automatically.
- Pick one or both.

Agency will now emit logs for different events such as entering a node, making an LLM call, making a tool call, throwing an interrupt, etc.

## Inspecting logs

The log file will be in JSONL format, which means one JSON object per line. This can be hard to read, so Agency comes with a log viewer.

```bash
agency logs view logs.jsonl
```

`view` is the default subcommand, so you can drop it:

```bash
agency logs logs.jsonl
```

Read from stdin:

```bash
cat run.jsonl | agency logs view -
```

Tail a file:

```bash
agency logs view -f logs.jsonl
```

The viewer opens on the overview when the log has one trace. A log with several traces opens the traces list. The `Started (local)` column shows the full date and a 12-hour time with seconds in your computer’s timezone. Move the highlight with `j` / `k` or the arrow keys; the header shows that trace's ID and position. Press `Enter` to open its overview, or `1`–`4` to open a particular tab. No tab is marked active while browsing the list.

Press `/` to search prompts, answers and tool results across traces. Press `Enter` to finish typing, then `Enter` again to open the trace screen at the matching content. Opening a specific trace from the runs explorer opens its overview.

### Keybindings

The footer shows key hints on one line, with the page title in the bottom right corner. Press `?` for the current screen's full key list. Scroll help with `j` / `k` or the paging keys; another key closes it. Number keys keep the same LLM call or tool selected as you move between screens.

| Key | Action |
|---|---|
| `1`, `2`, `3`, `4` | Overview, trace, transcript, timeline |
| `j`, `Down` / `k`, `Up` | Move down / up |
| `g` / `G` | Go to the top / bottom |
| `Ctrl+F`, `PageDown` / `Ctrl+B`, `PageUp` | Page down / up |
| `Ctrl+D` / `Ctrl+U` | Half-page down / up |
| `Enter` | Open a group, expand a block, or drill into a call |
| `Left` / `Right` | Select an overview call; climb out of / drill into the timeline |
| `Tab` | Toggle overview input/output or switch trace panes |
| `d` | Open full-screen detail from trace, transcript or timeline |
| `m` | Show machinery rows in the trace |
| `r` | Show raw JSON in the trace payload pane |
| `s` | Show or hide system prompts in overview input or on the selected transcript thread |
| `a` | Show admin rows in the trace or timeline |
| `/`, then text + `Enter` | Filter trace payloads or search the transcript and timeline |
| `n` / `N` | Next / previous match |
| `F` | Cycle trace filters: errors, tools, interrupts, all |
| `f` | Toggle follow mode for a local file |
| `y` | Copy the focused trace row's JSON or transcript block's text |
| `Y` / `x` | Copy the trace as JSONL / extract it to a file from the trace screen |
| `t` | Open the trace picker when there are several traces |
| `<` / `>` | Previous / next trace |
| `[` / `]` | Previous / next sibling in the trace outline or timeline, skipping descendants |
| `+`, `-`, `{`, `}`, `0` | Timeline zoom in, zoom out, pan left, pan right, reset |
| `Esc` | Back out one step; never quit |
| `?` | Show help |
| `q`, `Ctrl+C` | Quit |

`Esc` closes help or details and clears searches before leaving a screen. From trace, transcript or timeline, it returns to overview. From overview, it returns to the traces list when the log has several traces. On the list, it clears search first, then stays there or returns to the runs explorer when embedded. With a single trace, Escape from overview returns directly to the runs explorer when embedded. While editing search text, printable keys enter text; `Ctrl+C` still quits. Shared shortcuts such as `t traces` appear in the footer.

### 1: Overview

An **LLM call** is one completed request to the model. An Agency `llm()` invocation can make several LLM calls: the model requests a tool, receives its result, and is called again. Calls are numbered in the order they finish.

The overview links three bar graphs to a preview of the selected LLM call. Context, cost and time use the same call numbers and highlight the same call. The graphs sit on the left; the preview fills the right side.

```text
CONTEXT PER LLM CALL          LLM CALL 2 · [OUTPUT] INPUT
  ░█  ░█  ░█                 model name
   1   2   3                 200ms · $0.0000246
░ cached  ▒ fresh  █ output   context 13,920 · cached 13,824
                             fresh 96 · output 190
COST PER LLM CALL
   ▂   ▄   █                 The model's response or
   1   2   3                 requested tools appear here.

TIME PER LLM CALL
   ▂   ▄   █
   1   2   3
```

Use `Left` / `Right` (or `h` / `l`) to select a call. All three graphs scroll together when the trace has more calls than fit. `g` / `G` (or `Home` / `End`) select the first or last call. `Ctrl+F` / `Ctrl+B` move forward or back by a full page of visible calls; `Ctrl+D` / `Ctrl+U` move half a page. The page size follows the chart width. Each graph keeps its scale as you browse, so bar heights remain comparable. `Enter` opens the selected call in the trace screen.

Use `Up` / `Down` (or `k` / `j`) to scroll the preview, and `PageUp` / `PageDown` to scroll a page. `Ctrl+Home` / `Ctrl+End` jump to its start or end. The call's metrics stay visible above the preview. Selection stays on the same call when new log entries arrive.

Press `Tab` to switch between output and input. Input shows the complete recorded message list, including earlier conversation and tool replies, with each message's role labeled. System and developer prompts start collapsed; `s` shows or hides them. Each view remembers its own scroll position. Selecting another call keeps your chosen view, resets both scroll positions, and collapses its system prompts. Logs without recorded input show a message explaining that it is unavailable.

Context separates cached input, fresh input (including cache writes), and output. A context ceiling appears for a known model limit when the trace uses one model. Cost and time measure each completed model request. The preview shows exact recorded values, including small costs that would round to zero in the summary. It uses the trace screen's formatting for responses, code and tool requests.

### 2: Trace

What happened, and why? The outline places LLM calls, tools and interrupts in order. The right pane shows the focused row's full payload.

```text
  LLM call 8  tool: agencyGuide    5.0s │ ASSISTANT · LLM call 8
    agencyGuide effects.md        6ms │ TOOL CALL · agencyGuide
    ⚠ std::read approved              │ filename
▶ LLM call 9  tool: typecheck     23.7s │   effects.md
```

Trace’s key hints use two lines, wrapping between commands. `Enter` folds children. Completed thread groups start folded; running groups and groups you open stay expanded during updates. Press `p` to show successful approval rows, which are hidden by default. Rejected and unresolved approvals remain in the outline. Search and the interrupt filter can reveal successful approvals too. `Tab` switches between the Outline and Details panes; Left focuses Outline and Right focuses Details. Space pages down in the active pane. In Outline, `[` and `]` jump to the previous or next sibling, skipping its children and staying under the same parent. The active pane has a highlighted header marked `▶` and `↑↓ scroll`; arrow keys and paging affect that pane. The outline keeps its selection marker while Details is active, but its row background highlight is removed. `r` switches that pane to raw JSON, and `d` opens detail at full width. `/` searches complete payloads; `F` selects errors, tools or interrupts. Filters retain a match's ancestors. With `m` and `a` both on, the outline shows every forest node beneath the trace.

Nested LLM calls have bold purple thread headers, such as `Thread · main` or `Thread · reviewAgent`. A group can continue an existing thread: `main` may be the caller’s conversation continued by a handoff. Details show the tool that ran the group alongside its thread name. It also shows the model, completed call count, total LLM request time, cost and latest response. These metrics exclude nested tools. Press `r` to inspect the recorded JSON.

Tool outputs show an estimated token count, marked `~`, based on roughly four characters per token. It measures the result text, excluding message overhead; the model’s actual count can differ.

Tool status describes what the log recorded. Missing output means “completion not recorded.” A rejection alone does not establish whether earlier work ran. The viewer shows explicit evidence when an error records that work occurred or that the tool never started.

Press `#` to toggle line numbers in Trace, Transcript or Timeline. Each screen remembers its setting while the viewer is open. Trace numbers both panes; Transcript numbers its text lines; Timeline numbers rows in the current view. Numbers continue as you scroll. Trace outline numbers keep their positions through filtering and folding. Wrapped text is numbered after wrapping, so its line numbers can change when you resize or expand content.

### 3: Transcript

What did the model read and say? The transcript shows the conversation with a narrow LLM call list on the left.

```text
  system      │ system prompt · 62 lines · s to show
  user        │ ── USER ──
▶ LLM call 1  │ ── ASSISTANT · LLM call 1 ──  4.2s · 14k ctx · $0.001
    read      │ → read(notes.md)   260 lines   6ms
```

Each LLM call adds its new messages. Seeded history and unmatched refusal replies remain visible. A rewritten history adds a marker and its replacement messages, including system summaries. Structured answers show fields and highlighted code.

`Enter` expands a tool's arguments and result. `s` toggles the latest preceding system prompt on the selected block's thread. Distinct system prompts expand independently. `/` searches full content, including collapsed blocks; a match expands its block and scrolls into view. `j` / `k` move between blocks, while paging scrolls display lines within long blocks. `y` copies the full block text.

### 4: Timeline

When did work overlap? The timeline draws operation invocations and individual LLM calls as bars on a common time axis.

```text
  Thread · main        ░████████████████████░   1m33s
    LLM call 1         ░████░···············    4.2s
      read · notes.md  ·····░···············     6ms
    LLM call 2         ······░████░·········    7.4s
```

Tools nest beneath the LLM call that requested them, along with any work those tools perform. Their bars show tool execution time separately from the model's response time.

`Enter` or `Right` drills into a call; `Left` climbs out. `[` / `]` select the previous or next sibling, skipping nested rows and stopping at the parent boundary. `d` opens detail. `+` / `-` zoom, `{` / `}` pan, and `0` resets the time window. `/` searches row text. `a` reveals admin spans. A bar ending in `⋯` is still running.

### Highlighting slow calls

You can set the viewer to highlight slow or expensive LLM calls.
- Durations at or above `viewer.slowMs` (default 5 minutes) and costs at or above `viewer.expensiveUsd` (default $1) use amber and a `!` marker.
- Durations under `viewer.fastMs` (default 100ms) render in gray.

You can configure the thresholds for these in `agency.json`.

```json
{
  "viewer": {
    "slowMs": 5000,
    "fastMs": 100,
    "expensiveUsd": 0.01
  }
}
```

## References
- [Agency config file](/guide/agency-config-file)
