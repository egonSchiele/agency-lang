# Agent-init redesign — roadmap

Short status + sequencing guide for the multi-PR work tracked by
[`agent-init-design.md`](agent-init-design.md). Each row links to its
detailed plan under `docs/superpowers/plans/`.

## Status

| # | PR | Status | Plan |
|---|---|---|---|
| 1 | Runtime read-before-init trap | ✅ merged | [pr1-read-before-init-trap.md](docs/superpowers/plans/2026-05-31-agent-init-pr1-read-before-init-trap.md) |
| 2 | Per-variable topsort + centralized init | ✅ merged | [pr2-per-var-topsort.md](docs/superpowers/plans/2026-05-31-agent-init-pr2-per-var-topsort.md) |
| 2-stragglers | PR 2 review-cycle cleanups | ✅ merged | [pr2-stragglers.md](docs/superpowers/plans/2026-06-01-agent-init-pr2-stragglers.md) |
| 2.5 | Depth-1 function-body call-graph analysis | ✅ merged | [pr2.5-depth1-callgraph.md](docs/superpowers/plans/2026-06-01-agent-init-pr2.5-depth1-callgraph.md) |
| 3 | `static` prefix on bare top-level statements | ✅ merged | [pr3-static-bare-statements.md](docs/superpowers/plans/2026-05-31-agent-init-pr3-static-bare-statements.md) |
| 4 | Compile-time validations for static initializers | 📋 plan written | [pr4-static-validations.md](docs/superpowers/plans/2026-05-31-agent-init-pr4-static-validations.md) |
| 5 | `agency explain-init` CLI + phase trace events | 📋 plan written | [pr5-explain-init.md](docs/superpowers/plans/2026-05-31-agent-init-pr5-explain-init.md) |
| 6 | User-facing docs rewrite | 📋 plan written | [pr6-docs.md](docs/superpowers/plans/2026-05-31-agent-init-pr6-docs.md) |

## Recommended order

```diagram
╭──────────────╮
│ ✅ PR 1      │  runtime read-before-init trap
╰──────┬───────╯
       ▼
╭──────────────╮
│ ✅ PR 2      │  per-variable topsort + centralized init
╰──────┬───────╯
       ▼
╭──────────────╮
│ ✅ stragglers│  PR 2 cleanups — ship first, smallest, lowest risk
╰──────┬───────╯
       ▼
╭──────────────╮
│ ✅ PR 2.5    │  depth-1 call-graph — settles dep graph shape
╰──────┬───────╯
       ▼
╭──────────────╮
│ ✅ PR 3      │  static bare statements — inherits dep graph from 2.5
╰──────┬───────╯
       ▼
╭──────────────╮
│ 📋 PR 4      │  static-init validations — depends on PR 3's parser work
╰──────┬───────╯
       ▼
╭──────────────╮
│ 📋 PR 5      │  explain-init CLI — needs final dep graph shape
╰──────┬───────╯
       ▼
╭──────────────╮
│ 📋 PR 6      │  user docs — needs PR 5 to copy real output from
╰──────────────╯
```

## Why this order

- **Stragglers first.** Low-risk cleanups (rename, cycle-tracing fix,
  refactor, use-before-def error). Should land before any PR that
  builds on PR 2's surface so later diffs don't have to thread the
  old shape.
- **PR 2.5 before PR 3.** PR 3 extends the dep graph to include
  `static` bare statements; PR 2.5 extends `depsFor` with depth-1
  expansion. Doing 2.5 first means PR 3's bare-stmt nodes
  automatically get depth-1 expansion through their function calls.
  Reversing the order means PR 2.5 has to also update PR 3's new
  code paths.
- **PR 4 after PR 3.** PR 4's validations check both `static const`
  and `static` bare statements; the latter is added by PR 3.
- **PR 5 needs the final dep graph shape.** `explain-init` prints
  the plan; if PR 2.5 / PR 3 / PR 4 change what's in the plan,
  building the CLI before them wastes snapshot test work.
- **PR 6 last.** The user docs include sample `explain-init` output
  (PR 5) and the full rules around statics + cycles + indirect
  reads (PR 4). Writing docs before those land guarantees a rewrite.

## Effort summary

| PR | Effort |
|---|---|
| stragglers | ~1 day total (4 tasks; biggest is use-before-def at ~half day) |
| 2.5 | ~1–2 days |
| 3 | ~2–3 days |
| 4 | ~2–3 days |
| 5 | ~1–2 days |
| 6 | ~1 day |

**Total remaining: ~8–12 days of focused work** across 6 PRs.

## Dependencies that aren't obvious

- **Stragglers' use-before-def task** (Task 4) eliminates the silent
  intra-file reorder branch in `reorderTagged`. PR 3's static bare-
  statement work won't need it either; once landed, the branch is
  dead code.
- **PR 2.5's depth-1 analysis** plugs into the same
  `rejectStaticReferencesGlobal` check PR 2 already wired up, so
  PR 4's "no global reads from statics" validation gets the
  through-function case for free.
- **PR 5's `explain-init`** can reuse the `loadModule` helper
  extracted by Stragglers Task 2 — that's why the stragglers PR
  exports it module-private now and the plan says "let the second
  caller drive the public shape."
- **PR 6's docs** depend on PR 4's final list of banned operations
  inside static initializers — write that list first.

## Out of scope (won't be done as part of this redesign)

- Deep / transitive call-graph analysis beyond depth-1 (PR 2.5's
  boundary). The runtime trap remains the safety net.
- Higher-order function tracking (function values stored in
  variables).
- Method-call resolution on user objects.
- A real-time / live debugger view of the init pipeline (PR 5's
  trace events are post-hoc only).
