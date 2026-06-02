# PR 6 — Docs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Update user-facing docs to reflect the new two-phase init model, the `static` keyword extension to bare statements, the rules around circular imports, and the `agency explain-init` tool.

**Tech Stack:** VitePress site under `docs/site/`.

**Scope:**
- IN: rewrite `docs/site/guide/execution-model.md`
- IN: rewrite `docs/site/guide/global-vs-static.md`
- IN: new page `docs/site/guide/what-runs-when.md`
- IN: updated config.mts navigation
- IN: cross-linked `agency explain-init` reference
- OUT: API reference autogen (separate concern)

---

## Task 1: Rewrite execution-model.md

- [ ] Keep the existing motivating example (5 concurrent web-server requests, state isolation)
- [ ] Add a new section: "Two phases of initialization"
  - Phase A: once per process — `static const` decls + `static <stmt>` bare statements
  - Phase B: every run — non-static `const`/`let` decls + non-static bare statements
- [ ] Show worked example: file with both kinds; output across multiple runs
- [ ] Link to `what-runs-when.md` and `explain-init` CLI reference

---

## Task 2: Rewrite global-vs-static.md

- [ ] Extend `static` description to include bare statements (`static foo()`)
- [ ] Add subsection on cross-module dependencies: "Statics across files initialize in topological order; if you depend on a static from another module, it's already initialized when yours runs."
- [ ] Add subsection on circular imports: allowed at file level, banned at variable level. Worked router example.
- [ ] Note the `static let` restriction (still banned)

---

## Task 3: New page — `what-runs-when.md`

- [ ] Audience: someone who's added a `static foo()` and wants to know when it fires
- [ ] Sections:
  - The two phases (quick recap)
  - How to find out: `agency explain-init` (with sample output)
  - Restrictions: what can't be done inside `static` initializers
  - Cycles: when they're allowed, when they error, how to fix
  - Indirect deps through function calls: the runtime read-before-init error and how to interpret it

---

## Task 4: Update navigation

- [ ] Modify `docs/site/.vitepress/config.mts` to include the new page in the guide sidebar

---

## Task 5: Update appendix / reference

- [ ] If there's a CLI reference page, document `agency explain-init`
- [ ] Cross-link from the relevant guide pages

---

## Pre-PR checklist

- [ ] All updated pages render cleanly in dev server
- [ ] Sample outputs match actual `explain-init` output
- [ ] Internal links work
- [ ] PR description references design doc, notes PR 6 of 6
