# Observability

Agency emits structured events for each step of an agent run — entering a
node, calling an LLM, throwing an interrupt, forking branches, and so
on. These events are written by `StatelogClient` and you can opt in to
collecting them by setting `observability: true` in your `agency.json`.

## Enabling observability

In your `agency.json`, set `observability: true` and configure at least
one sink:

```json
{
  "observability": true,
  "log": {
    "host": "stdout",
    "logFile": "runs/latest.jsonl"
  }
}
```

Sinks:

- `host: "stdout"` — prints one JSON envelope per line to `console.log`.
- `logFile: "<path>"` — appends one JSON envelope per line to the given
  file. The parent directory is created automatically.
- Both can be configured at once.

## Inspecting logs

Once you have a `.jsonl` log file, view it interactively:

```bash
agency logs view path/to/run.jsonl
```

Read from stdin:

```bash
cat run.jsonl | agency logs view -
```

### Keybindings

| Key | Action |
|---|---|
| `j`, `Down`, `Ctrl+N` | Move cursor down |
| `k`, `Up`, `Ctrl+P` | Move cursor up |
| `l`, `Right`, `Enter` | Expand the focused node (or jump into its children) |
| `h`, `Left` | Collapse the focused node (or jump to its parent) |
| `g` | Jump to the top |
| `G` | Jump to the bottom |
| `q`, `Ctrl+C` | Quit |

A single-trace file opens with the trace expanded; multi-trace files
open with everything collapsed.
