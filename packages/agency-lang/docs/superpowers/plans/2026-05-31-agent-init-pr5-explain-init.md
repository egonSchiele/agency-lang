# PR 5 — `agency explain-init` CLI + trace events

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make the init order observable. Users can run a single command to see exactly what runs at startup vs per-run, and trace events tag the phase boundaries during real execution.

**Architecture:** New CLI subcommand that loads + analyzes (without executing) an entry agency file, builds the dep graph + topsort from PR 2, and prints a human-readable plan. Separately, the runtime emits `phase-a-start` / `phase-a-end` / `phase-b-start` / `phase-b-end` events into statelog/trace.

**Tech Stack:** CLI script in `scripts/agency.js`, runtime trace emission.

**Scope:**
- IN: `agency explain-init <entry.agency>` command
- IN: human-readable output: Phase A, Phase B, dep graph, detected import cycles
- IN: trace/statelog events for phase boundaries
- OUT: real-time / live debugger integration (future)

---

## Task 1: CLI subcommand

**Files:**
- Modify: `scripts/agency.js` (or wherever the CLI is wired)
- Create: `lib/commands/explainInit.ts`

- [ ] Add `explain-init <file>` subcommand
- [ ] Load + parse + build dep graph (reusing PR 2 machinery)
- [ ] Print:
  ```
  Phase A (once per process):
    bar.agency:1   static const barStatic = "hello"
    foo.agency:2   static const fooStatic = barStatic + "!"
    foo.agency:5   static logEvent("startup")

  Phase B (every run):
    foo.agency:7   const requestLog = []
    foo.agency:8   logEvent("agent run started")

  Variable dependency graph:
    bar.barStatic       (no deps)
    foo.fooStatic       depends on: bar.barStatic
    foo.requestLog      (no deps)

  Cyclic imports detected (allowed):
    router.agency ⇄ code.agency
    router.agency ⇄ research.agency
  ```

---

## Task 2: Snapshot tests

**Files:**
- Create: `tests/commands/explainInit.test.ts`
- Create: small fixture agency files in `tests/fixtures/explain-init/`

- [ ] Run `explain-init` against each fixture; snapshot output
- [ ] Cover: single-file static, cross-module dep, re-export chain, router pattern (cyclic imports), bare statements with and without `static`

---

## Task 3: Runtime trace events

**Files:**
- Modify: `lib/runtime/node.ts` (around the `__initializeStatic` / `__initializeGlobals` calls)
- Modify: `lib/runtime/trace/...` to define the new event types

- [ ] Emit `phase-a-start` before Phase A runs, `phase-a-end` after
- [ ] Same for Phase B
- [ ] Include the sorted item list (or summary) in the event payload
- [ ] Test: a trace fixture that runs an agent and asserts the events appear in expected order

---

## Pre-PR checklist

- [ ] CLI command works end-to-end
- [ ] Snapshot tests cover the main patterns
- [ ] Trace events visible in statelog output
- [ ] PR description references design doc, notes PR 5 of 6
