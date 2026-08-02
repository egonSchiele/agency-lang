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
