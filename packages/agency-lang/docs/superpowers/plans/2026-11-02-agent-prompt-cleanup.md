# Agent prompt cleanup

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the scoped tasks below.

**Goal:** Confirm and document whether ordinary tools expose their return schemas, and simplify the built-in agent prompts without changing their tools or runtime behavior.

**Architecture:** Keep purpose, decision rules, completion criteria, and communication expectations in prompts. Keep tool mechanics in their existing descriptions. Preserve specialized instructions when they explain requirements the model cannot infer.

**Tech stack:** Agency source, Markdown prompts, TypeScript compiler and runtime inspection.

**Spec:** The user's November 2 request and the preceding research recommendations in this chat authorize this work and PR creation.

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

- [x] Trace return types from code generation through tool definitions and provider adapters. Capture a small deterministic reproduction. Write `docs/dev/agents/tool-return-schema-gap.md` with evidence, code pointers, impact, and acceptance criteria.
- [x] Simplify the active coordinator and interactive coding prompts, preserving product decisions and correcting the explorer context claim. Inspect one-shot prompts and tool descriptions before removing duplicates.
- [x] Review the stdlib agents and simplify their standing prompts where useful. Preserve the tutorial byte-for-byte and existing prompt interpolations and behavior. Leave already concise prompts alone when no useful cut exists.
- [x] Build, run focused existing tests, check formatting, and verify the tutorial is unchanged. Review the complete diff and address findings.
- [ ] Commit the changes, push the task branch, and create a PR with the evidence, validation, and remaining evaluation limits.

## Verification

- `make`, TypeScript formatting and its check, structural lint, and `git diff --check` passed.
- The focused tests passed: 105 cases across 15 files, using the mocked LLM provider. The first run's zero-cost guard rejected simulated costs; the 12 affected files passed after removing that guard.
- The compiled return-schema reproduction confirms that ordinary tool metadata omits the declared return type.
- The tutorial is byte-identical to the base revision. The stdlib changes preserve code outside string literals and all ordered prompt interpolations.
- Independent review found no actionable issues. Deterministic tests verify compilation and wiring; they do not establish model quality.
- Six approved live calls compared the old and revised main coordinator prompt on identity, missing email details, and a focused repository read. Both versions made all three expected routing choices. Estimated total cost was $0.042306. The revised read call included an undeclared `useAgentCwd` argument mentioned in the copied docstring. The reduced harness used eleven inert tools and representative schemas; it did not execute tools or test the production agent loop. This observation needs production verification before attributing it to a prompt or runtime defect.
