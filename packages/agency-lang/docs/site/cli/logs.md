---
title: Viewing logs and exploring runs
description: Documents the `agency logs` command — the interactive statelog viewer for a single run, and the cross-run explorer for comparing many runs, agents, and suites.
---

# Viewing logs and exploring runs

`agency logs` points at anything log-shaped and opens the right tool:

```
agency logs <file.jsonl>          # one statelog → the interactive log viewer
agency logs <file.jsonl> -f       # same, tailing the file as it grows
agency logs <runDir>              # one eval run → its per-test table
agency logs <runsDir>             # a directory of runs → the runs explorer
agency logs runs/ extra.jsonl     # any mix of paths → one merged table
agency logs runs/ --csv           # print the table as CSV to stdout
```

Paths are classified automatically: a file whose first line is a statelog
event is a statelog (every trace inside it becomes a row); a directory
containing `summary.json` is an eval run; any other directory is scanned
one level deep for runs.

## The log viewer (single statelog)

A sole statelog file opens the interactive viewer: the event tree,
timeline views (`t`), search, and follow mode. `agency logs view <file>`
is the same thing spelled explicitly, and `-` reads from stdin. See the
viewer's own help (`?`) for keys.

A file that holds several traces opens on a list of them. To skip the
list and open one trace directly, name it:

```bash
agency logs run.jsonl --trace-id k3Pq9abc   # a full id, or a unique prefix
```

The other traces stay reachable with `t`. Under `--follow` the trace may
not have started yet; the viewer then waits on it and shows it when its
first event arrives.

## Labeling a trace from the viewer

When you view a **local** statelog file, the tree's `l` key labels the
trace your cursor is in: it writes the trace into a human-judged
[dataset](/cli/eval) and drops you straight into labeling it — the moment
you notice an agent did something well or badly, you can capture it.
`Right`/`Enter` expand the focused node. `l` never expands; where labeling
is unavailable (stdin or remote logs) it does nothing.

```bash
# label into ./labels (the default), against a checklist
agency logs view run.jsonl --checklist news.json

# label into a specific dataset
agency logs --dataset team-labels --checklist news.json run.jsonl
```

- `--checklist <file>` — the yes/no questions you judge against. Without
  it, `l` just reminds you to pass one (nothing is written).
- `--dataset <dir>` — where labels live (default `eval.dataset`, else
  `labels/`).

Pressing `l` resolves the trace's output (an `evalOutput()`, else the
entry node's return value), lets you edit the task text, writes the
example into the dataset, and opens the labeling screen focused on it. See
[Judging output by hand](/cli/eval#judging-output-by-hand) for the
labeling UI itself. Labeling refuses a statelog with unparseable lines, so
a dataset is never built from a partially read trace.

These options also flow into the runs explorer: drilling from a run into
its statelog enables the same `l` labeling.

## The runs explorer (many runs)

Everything else opens the explorer: one sortable row per run.

Columns: date, agent, suite, score, pass, status, cost, time, models.
The `agent` column prefers the name set by `setAgentName` from
`std::statelog` — call it once in your agent and every run groups under
that identity, whatever command launched it. Cost and time cells show
`…` while old or killed runs are still being backfilled from their
statelogs, and fill in live.

Keys (matching the log viewer where they overlap):

| Key | Action |
| --- | --- |
| `j`/`k`, arrows, `g`/`G`, `Ctrl+F/B/D/U` | move / page |
| `t` / `Shift+T` | cycle runs table → compare → trend |
| `s` / `Shift+S` | cycle the sort column / flip direction |
| `b` | group by agent, then suite, then off |
| `Enter` | expand a group, open a run's tests, or open a test's log in the viewer |
| `i` | run info (full command, paths, warnings) |
| `e` | export the current table as CSV (`runs-export-<timestamp>.csv`) |
| `Esc` | back one screen; never quits |
| `q` | quit instantly, from any screen, even mid-load |

The **compare** view is an agent × suite matrix of mean scores (with run
counts, graded runs only). The **trend** view shows score-over-time
sparkrows per agent, bucketed by day or week to fit the terminal.

Drilling into a test hands the same terminal to the log viewer; `Esc`
backs out to the table, `q` quits the whole program.

## Comments and sessions

When you review a run with a coding agent, the slow part is pointing: "the
fourth LLM call on the reviewer thread, where it reads the config again".
The viewer can hand the agent that spot directly.

**Addresses.** Every row has an address, `<trace id>/<row id>`. `A` copies
the focused row's address on any screen; paste it to the agent.

**Comments.** `c` leaves a comment on the focused row (or on the row a
detail view shows). The row gains a `✎` in the gutter, and its comments are
listed under its payload. Comments live beside the log, in
`comments.jsonl` for a run directory or `<file>.comments.jsonl` beside a
loose statelog. The log itself is left as the runtime wrote it. Logs read from stdin or a remote server have no comments.
An agent's answer to your comment shows under it. An agent's own notes are
hidden until `C` shows them, so your reading stays yours.

**Sessions.** While the viewer is open, the `agency logs session` commands
can talk to it from another terminal. That is what the agent uses:

```bash
agency logs session get                      # the row under your cursor, expanded
agency logs session show k3Pq9abc/round:span-7f3a:2
agency logs session comments                 # your comments on the open trace, each with its row
agency logs session comment add k3Pq9abc/round:span-7f3a:2 "it retries after a cache miss" --reply-to c_8f2a
agency logs session navigate k3Pq9abc/span-9c01   # move your viewer to a row
agency logs session list                     # the open viewers
```

Each prints the row the way the viewer shows it: its address, a header
line such as `Thread · reviewer · LLM call 4 of 9 · gpt-5 · 2.1s · $0.004`,
and the payload. `--json` gives the same facts as fields plus the row's raw
events. With no viewer open, `show`, `comments`, and `comment add` work on
the files when given `--log <file>`; `get` and `navigate` need the viewer.
A bare row id needs `--trace <id>`; an address carries its trace. The viewer
registers itself under the agent home (`~/.agency-agent/log-sessions/`) and
removes the record when it quits; nothing runs in the background on its
own. The `/debug-logs` command in this repo teaches the agent these steps.

## CSV export

`--csv` skips the TUI, waits for every run to finish loading (including
statelog backfill), and prints the ungrouped table to stdout for piping.
The interactive `e` key instead writes a file and exports exactly what
the table shows — current sort and grouping, with group members always
listed under their headers.

## `agency eval logs`

`agency eval logs <runDir>` opens that run's per-test table. With
`--input <id>` (or when pointed at an input directory or statelog file
directly) it opens the viewer on that one statelog, and `-f` tails it —
handy for watching a live parallel eval.
