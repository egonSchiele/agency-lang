---
name: agency-evals-docs
description: Developer docs for Agency evals: the run directory that running, grading, labeling and optimizing share, grading, trial tracking and upload, hand labeling, running a CLI as the agent, writing optimizers, and Terminal-Bench benchmarking. Use when changing `agency eval`, grading, or optimization.
---

# Evals developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/evals/run-directory.md` — The on-disk shape that observing, noting, labeling, grading, and optimizing all read and write.
- `docs/dev/evals/eval-grading.md` — Why running and grading are separate, joined only by the run directory.
- `docs/dev/evals/eval-tracking.md` — Running a suite over several trials, then uploading the results to statelog for a trend.
- `docs/dev/evals/eval-labeling.md` — Answering a checklist about a group of runs by hand, and how those answers are recorded.
- `docs/dev/evals/eval-command-agents.md` — Running an arbitrary CLI as the eval agent instead of an `.agency` file.
- `docs/dev/evals/writing-optimizers.md` — Adding a new `optimize` strategy alongside `greedy` and `gepa`.
- `docs/dev/evals/terminal-bench.md` — Benchmarking the coding agent against Terminal-Bench, and the results so far.
