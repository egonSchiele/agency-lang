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

The viewer opens on the overview when the log has one trace. A log with several traces opens a trace picker. Pick a trace with `j` / `k` and `Enter`, or press `/` to search prompts, answers and tool results across traces. A searched selection opens the trace screen at the matching content. Opening a specific trace from the runs explorer opens its overview.

### Keybindings

Press `?` for the current screen's keys. Scroll help with `j` / `k` or the paging keys; another key closes it. Number keys keep the same round or tool selected as you move between screens.

| Key | Action |
|---|---|
| `1`, `2`, `3`, `4` | Overview, trace, transcript, timeline |
| `j`, `Down` / `k`, `Up` | Move down / up |
| `g` / `G` | Go to the top / bottom |
| `Ctrl+F`, `PageDown` / `Ctrl+B`, `PageUp` | Page down / up |
| `Ctrl+D` / `Ctrl+U` | Half-page down / up |
| `Enter` | Open a group, expand a block, or drill into a call |
| `Left` | Climb out of a timeline drill |
| `Tab` | Switch overview panels or trace panes |
| `d` | Open full-screen detail from trace, transcript or timeline |
| `m` | Show machinery rows in the trace |
| `r` | Show raw JSON in the trace payload pane |
| `s` | Show or hide the system prompt on the selected transcript thread |
| `a` | Show admin rows in the trace or timeline |
| `/`, then text + `Enter` | Filter trace payloads or search the transcript and timeline |
| `n` / `N` | Next / previous match |
| `F` | Cycle trace filters: errors, tools, interrupts, all |
| `f` | Toggle follow mode for a local file |
| `y` | Copy the focused trace row's JSON or transcript block's text |
| `Y` / `x` | Copy the trace as JSONL / extract it to a file from the trace screen |
| `t` | Open the trace picker when there are several traces |
| `<` / `>` | Previous / next trace |
| `+`, `-`, `[`, `]`, `0` | Timeline zoom in, zoom out, pan left, pan right, reset |
| `Esc` | Back out one step; never quit |
| `?` | Show help |
| `q`, `Ctrl+C` | Quit |

`Esc` closes help, clears an overlay's state, closes the overlay, clears the screen's state, then returns to overview. From overview it returns to the runs explorer when embedded. While editing picker search text, printable keys enter text; `Ctrl+C` still quits.

### 1: Overview

Where did the run spend its time and tokens? The overview shows time by group, context per round, spend per round, and notable rounds.

```text
TIME BY GROUP                CONTEXT BY ROUND
coding agent  ███████  77%    cached ▓   fresh █   output ░
read          ██       9%    14k  15k  18k  20k

SPEND BY ROUND               NOTABLE ROUNDS
$0.001 $0.005 $0.003          slowest: round 9 · 23.7s
```

Press `Tab` to move between groups and notable rounds. `Enter` opens a group's individual calls or the trace at a notable round. Time groups use self-time, excluding nested calls. A group's share can exceed 100% when work overlaps. Context includes cached input, fresh input and cache writes; output is shown separately. A context ceiling appears when the model's limit is known.

### 2: Trace

What happened, and why? The outline places rounds, tools and interrupts in order. The right pane shows the focused row's full payload.

```text
  round 8  tool: agencyGuide   5.0s! │ ASSISTANT · round 8
    agencyGuide effects.md      6ms │ REQUEST · agencyGuide
    ⚠ std::read approved            │ filename
▶ round 9  tool: typecheck     23.7s!│   effects.md
```

`Enter` folds children. `Tab` moves scrolling to the payload. `r` switches that pane to raw JSON, and `d` opens detail at full width. `/` searches complete payloads; `F` selects errors, tools or interrupts. Filters retain a match's ancestors. With `m` and `a` both on, the outline shows every forest node beneath the trace.

Tool status describes what the log recorded. Missing output means “completion not recorded.” A rejection alone does not establish whether earlier work ran. The viewer shows explicit evidence when an error records that work occurred or that the tool never started.

### 3: Transcript

What did the model read and say? The transcript shows the conversation with a narrow round list on the left.

```text
  system      │ system prompt · 62 lines · s to show
  user        │ ── USER ──
▶ round 1     │ ── ASSISTANT · round 1 ──  4.2s · 14k ctx · $0.001
    read      │ → read(notes.md)   260 lines   6ms
```

Each round adds its new messages. Seeded history and unmatched refusal replies remain visible. A rewritten history adds a marker and its replacement messages, including system summaries. Structured answers show fields and highlighted code.

`Enter` expands a tool's arguments and result. `s` toggles the latest preceding system prompt on the selected block's thread. Distinct system prompts expand independently. `/` searches full content, including collapsed blocks; a match expands its block and scrolls into view. `j` / `k` move between blocks, while paging scrolls display lines within long blocks. `y` copies the full block text.

### 4: Timeline

When did work overlap? The timeline draws calls and rounds as bars on a common time axis.

```text
  llm · write a module  ░████████████████████░   1m33s
    round 1            ░████░···············    4.2s
    read · notes.md    ·····░···············     6ms
    round 2            ······░████░·········    7.4s
```

`Enter` or `Right` drills into a call; `Left` climbs out. `d` opens detail. `+` / `-` zoom, `[` / `]` pan, and `0` resets the time window. `/` searches row text. `a` reveals admin spans. A bar ending in `⋯` is still running.

### Highlighting slow calls

You can set the viewer to highlight slow or expensive LLM calls.
- Durations over `viewer.slowMs` (default 5s) and costs over `viewer.expensiveUsd` (default $0.01) use an alert color and a `!` marker.
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