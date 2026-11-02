# Agent prompt cleanup

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the scoped tasks below.

**Goal:** Confirm and document whether ordinary tools expose their return schemas, and simplify the built-in agent prompts without changing their tools or runtime behavior.

**Architecture:** Keep purpose, decision rules, completion criteria, and communication expectations in prompts. Keep tool mechanics in their existing descriptions. Preserve specialized instructions when they explain requirements the model cannot infer.

**Tech stack:** Agency source, Markdown prompts, TypeScript compiler and runtime inspection.

## Constraints

- Do not change `stdlib/agents/prompts/agency-tutorial.md` or remove its inclusion.
- Document the return-schema issue; do not implement a compiler or runtime fix.
- Preserve tool availability, handlers, budgets, output contracts, and agent entry points.
- Remove repetition, tool parameter catalogs, stale context claims, and excessive emphasis.
- Retain useful domain requirements, evidence standards, clarification rules, and verification.
- Do not create abstractions or move instructions into new skills merely to shorten files.
- Use an isolated worktree inside `packages/agency-lang`.
- Save test output. Run `make` after stdlib edits, focused tests, and formatting checks. Do not run the full Agency test suite.

## Review focus

- Handoff agents continue the caller's conversation; prompts must match that behavior.
- Prompt edits must retain each agent's return format and source requirements.
- The code agent must still verify changes and report failures accurately.
- The issue must distinguish tool outputs from structured LLM responses and MCP schemas.
- Prompt length alone does not establish effectiveness; report validation limits.

## Tasks

- [x] Trace return types from code generation through tool definitions and provider adapters. Capture a small deterministic reproduction. Record the confirmed gap and acceptance criteria in [issue #1362](https://github.com/egonSchiele/agency-lang/issues/1362).
- [x] Simplify the active coordinator and interactive coding prompts, preserving product decisions and correcting the explorer context claim. Inspect one-shot prompts and tool descriptions before removing duplicates.
- [x] Review the stdlib agents and simplify their standing prompts where useful. Preserve the tutorial byte-for-byte, existing prompt interpolations, and runtime implementation. Leave already concise prompts alone when no useful cut exists.
- [x] Build, run focused existing tests, check formatting, and verify the tutorial is unchanged. Review the complete diff and address findings.
- [x] Commit the changes, push the task branch, and create a PR with the evidence, validation, and remaining evaluation limits.

## Review follow-up

- [x] Restore saved-tool discovery, concrete review routing, one-shot action and execution rules, research-round guidance, and conditional draft saving.
- [x] Organize the code prompt by when guidance applies, with actionable bullets and checked Agency examples. Restore editing and spill-reading rules. Remove memory guidance.
- [x] Restore the writing review and rewrite prompts to their existing baseline until their dedicated suites support a change.
- [x] Move the return-schema report to a GitHub issue with commit-pinned links and preserve a local copy outside the PR.
- [x] Rebuild and run focused deterministic checks for the corrections: `make`, formatting/check, 42 tests across seven files, and strict compilation of both Agency examples passed.
- [ ] Compare old and revised prompts with the existing suites on their default models. Record per-suite scores and review regressions before merging.

The six-call smoke check and deterministic tests do not establish behavior
across these agents. Full before/after evaluation at three trials covers
113 tests and 678 agent runs, followed by separate grading.
