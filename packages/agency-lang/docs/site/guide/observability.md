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

Tail a file that is still being written to (e.g. a long-running
agent):

```bash
agency logs view --follow path/to/run.jsonl
```

### Keybindings

| Key | Action |
|---|---|
| `j`, `Down`, `Ctrl+N` | Move cursor down |
| `k`, `Up`, `Ctrl+P` | Move cursor up |
| `l`, `Right` | Expand the focused node (or jump into its children) |
| `Enter` | Expand; on a leaf, open the JSON payload pane and focus it |
| `h`, `Left` | Collapse the focused node (or jump to its parent) |
| `g` | Jump to the top |
| `G` | Jump to the bottom |
| `Tab`, `Shift+Tab` | Jump cursor to the next / previous trace |
| `e` / `E` | Expand all / collapse all |
| `p` | Toggle the JSON payload pane |
| `/`, then text + Enter | Search rows for a substring |
| `n` / `N` | Jump to next / previous match |
| `Esc` | Clear active search |
| `y` | Copy the focused node's JSON to the clipboard |
| `f` | Toggle follow mode at runtime |
| `?` | Show / hide the keybinding help |
| `q`, `Ctrl+C` | Quit |

A single-trace file opens with the trace expanded; multi-trace files
open with everything collapsed.

### JSON payload pane

Press `Enter` on a leaf to open a bottom split-pane that renders the
event's full payload as a collapsible JSON tree (objects/arrays show
as `▶ { 3 keys }` collapsed and expand on `l` or `Enter`). Long
strings (with newlines or > 80 chars) collapse to a preview. The pane
follows the focused leaf in the tree; `Esc` releases focus back to
the tree; `p` toggles the pane.

### Search

Press `/`, type a substring, then `Enter`. Matches are highlighted
in-place (yellow background), the cursor jumps to the first match,
and ancestors of matches are auto-expanded so they are visible.
Cycle with `n` / `N`; clear with `Esc`. The status bar shows
`match i/n — "query"`.

### Magnitude coloring

Durations over `viewer.slowMs` (default 5s) and costs over
`viewer.expensiveUsd` (default $0.01) render in bright-red; durations
under `viewer.fastMs` (default 100ms) render gray. Configure in
`agency.json` under the `viewer` key.
