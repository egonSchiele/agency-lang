---
name: Observability
description: How to enable Agency's structured logging for events like node entry, LLM calls, tool calls, and interrupts, and how to view the resulting JSONL logs.
---

# Observability

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

### Keybindings

Press `?` in the viewer to see this info.

| Key | Action |
|---|---|
| `j`, `Down`, `Ctrl+N` | Move cursor down |
| `k`, `Up`, `Ctrl+P` | Move cursor up |
| `l`, `Right`, `Enter` | Expand the focused node — on a span/trace, reveal children; on a leaf, inline the JSON payload |
| `h`, `Left` | Collapse the focused node (or jump to its parent) |
| `g` | Jump to the top |
| `G` | Jump to the bottom |
| `Ctrl+F`, `PageDown` / `Ctrl+B`, `PageUp` | Page down / up |
| `Ctrl+D` / `Ctrl+U` | Half-page down / up |
| `Tab`, `Shift+Tab` | Jump cursor to the next / previous trace |
| `e` / `E` | Expand all / collapse all |
| `/`, then text + Enter | Search rows for a substring |
| `n` / `N` | Jump to next / previous match |
| `Esc` | Clear active search |
| `y` | Copy the focused node's JSON to the clipboard |
| `f` | Toggle follow mode at runtime |
| `t` | Open the timeline views (see below) |
| `d` | Full details of the focused call (prompt transcript, tool arguments) |
| `?` | Show / hide the keybinding help |
| `q`, `Ctrl+C` | Quit |

### Timeline views

Press `t` to see where a run spent its time. `t` cycles tree → **flame** → **by-name** →
tree, and works in `agency eval logs <runDir>` too.

The **flame view** shows one row per call, indented by nesting, as bars on a shared time
axis. Rows say what each call was doing — an LLM row shows the question it was asked plus
tokens and cost (never just the model name), a tool row shows its argument (the bash
command, the file path):

```
llm · Classify this coding task. If …  ░···················        3.4s
llm · Task: There's a file called te…  ░████░··············       1m33s
llm · There's a file called text.gco…  ·····███████████████       15m59s
  bash · pip install matplotlib 2>&1…  ··········░░········        3.7s
```

`Enter`/`→` drills into the selected call — only it and its descendants remain, the axis
rescales, and a breadcrumb shows the path. `←` climbs back out. `Enter` on a leaf (or `d`
anywhere) opens the full-detail screen. `+`/`-` zoom, `[`/`]` pan, `0` resets. `o` jumps
back to the tree view focused on that call.

The **by-name view** groups calls: LLM calls by their thread label (else the function they
were called from, else the model), tools by name. One row per group, with call count, total
**self-time** (the time a call spent itself, not waiting on nested calls — so a wrapping
LLM span cannot claim its subagents' time), and share of the run:

```
llm(codingAgent)     ·······▓██████▓▓████████▓██▒······    1×  15m21s  77%
llm(verifierAgent)   ··························▓█████      2×   1m48s   9%
bash                 ·······░░·░··░░▒▒░░···░··░░▒░░       62×     41s   3%
```

A share above 100% means the work ran in parallel (forked branches). `Enter` opens the
**occurrences view**: every call of that group in order, each with where it came from, so
"bash ran 62 times" becomes inspectable call by call.

Bar shading is busyness: `░` means the function ran for up to a quarter of that time slice,
`█` means nearly all of it. A bar ending in `⋯` is still running (follow mode). Bookkeeping
spans (interrupt handler checks) are hidden by default — press `a` to show them.

### Highlighting slow calls

You can set the viewer to highlight slow or expensive LLM calls.
- Durations over `viewer.slowMs` (default 5s) and costs over `viewer.expensiveUsd` (default $0.01) are rendered in bright-red.
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