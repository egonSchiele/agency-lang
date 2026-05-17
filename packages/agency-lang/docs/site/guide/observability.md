# Observability

If you would like agency to emit structured logs, set `observability: true` in your `agency.json`. Agency will now emit logs for different events such as entering a node, making an LLM call, making a tool call, throwing an interrupt, etc.

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

## Inspecting logs

The log file will be in JSONL format, which means one JSON object per line. This can be hard to read, so Agency comes with a log viewer.

```bash
agency logs view logs.jsonl
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
| `?` | Show / hide the keybinding help |
| `q`, `Ctrl+C` | Quit |

### Magnitude coloring

You can set the viewer to highlight slow or expensive LLM calls. Durations over `viewer.slowMs` (default 5s) and costs over `viewer.expensiveUsd` (default $0.01) render in bright-red; durations under `viewer.fastMs` (default 100ms) render in gray. You can configure the thresholds for these in `agency.json`.

```json
{
  "viewer": {
    "slowMs": 5000,
    "fastMs": 100,
    "expensiveUsd": 0.01
  }
}
```
