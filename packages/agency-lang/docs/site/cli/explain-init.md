---
title: Inspecting initialization order
description: Documents the `agency explain-init` command for printing the two-phase initialization plan (Phase A statics, Phase B globals) and detected cross-module dependencies for an Agency entry file.
---

# Inspecting initialization order

```
agency explain-init <entry.agency>
```

Loads the entry file's full import closure and prints a human-readable summary of:

- **Phase A** — declarations and bare statements marked `static`, which run once per process.
- **Phase B** — non-static declarations and bare statements, which run on every agent run.
- **Variable dependency graph** — which top-level vars depend on which others, across files. This is the graph the compiler topologically sorts to choose the initialization order.
- **Cyclic imports** — file-level cycles that are *allowed* by Agency (functions are not part of the dep graph, so two files can import functions from each other without forming a value-level cycle).

The command is pure analysis: it parses, builds the dep graph, and reports. It does NOT execute any user code, so it is safe to run against agents that hit the network or modify disk on startup.

## Example output

```
Phase A (once per process):
  bar.agency:1   barStatic
  foo.agency:2   fooStatic
  foo.agency:5   <bare statement>

Phase B (every run):
  foo.agency:7   requestLog
  foo.agency:8   <bare statement>

Variable dependency graph:
  bar.barStatic       (no deps)
  foo.fooStatic       depends on: bar.barStatic
  foo.requestLog      (no deps)
  foo.<bare statement> depends on: foo.requestLog

Cyclic imports detected (allowed): none
```

## When to reach for it

- You added a `static const` or `static <stmt>` and want to confirm it runs at the time you expect.
- You see the runtime "read-before-init" error and want to inspect the closure-wide init order.
- You want to verify a refactor preserved the previous initialization sequence.
