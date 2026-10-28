# Tool Output Lifecycle Implementation Plan

> **For agentic workers:** Use the existing worktree and test-first workflow. Steps use checkboxes for tracking.

**Goal:** Give custom tools one presentation, unify web searches, and distinguish starts from completions.

**Architecture:** One declarative table selects a tool presentation for both start and end. Event descriptions remain data consumed by the shared renderer. Search metadata comes from the existing catalog; source rows use the normalized provider fields. The existing recorded runtime end step also handles settled failures and rejections.

**Tech Stack:** TypeScript, Agency, Vitest, scripted Agency-JS fixtures.

**Spec:** The user's October 27 follow-up requests removal of duplicate research and todo output, consistent search displays, readable search results, and distinct completion styling. The details below are implementation choices.

## Contract

- Todo calls print a returned checklist or a named failure, without a start block.
- Subagents announce once through the shared renderer. Keep announcements for direct calls from code, and suppress generic starts for their registered tool names.
- All searches use the title `Web search`. Starts are blue with `⌕`; known successful completions are green with `✓`; hosted reports remain neutral because their records have no success status.
- Print full queries. Show normalized source titles and URLs, up to five, then the remaining source count. Missing hosted sources do not mean zero results. Do not decode raw provider objects.
- Ordinary successful and plain returns use a green check and `Tool finished`; failures use red. Dim ordinary result previews. Markers and words still distinguish states without color.
- A custom presentation owns both start and end behavior, including malformed input. Only unregistered tools use generic formatting.
- Keep event descriptions independent; do not pair concurrent calls by name or add an output cache.
- Preserve tool results, model messages, approvals, cancellation, and interrupt resume. Calls refused before invocation keep their existing behavior. Paused calls do not emit a completion.
- Retain static imports, types, objects, arrays, shared sanitizing/wrapping, and current visibility flags.
- Leave unrelated pre-existing generated package edits untouched. Save check outputs, run no full Agency suite or live model/search calls, and use message files for commits and PR edits.

## Task 1: Complete the tool lifecycle

Files: `lib/runtime/prompt.ts`, focused lifecycle fixture, `docs/dev/runtime/callback-hooks.md`.

- [x] Add failing tests for genuine failures, crashes, and rejections; no completion while paused; exactly one completion after resume; handoff outcomes; and no completion for cancellation/guard abort or pre-invocation refusals.
- [x] Reuse branch results and recorded end steps for settled failures. Preserve result values and success-only logging. Let the batch clear settled branches.
- [x] Run the focused lifecycle tests and relevant existing rejection/resume/handoff fixtures.

## Task 2: Render one custom presentation per tool

Files: `lib/stdlib/agentToolTrace.ts`, its unit tests, `lib/agents/agency-agent/lib/trace.agency`, coordinator announcement helper and its seven callers, and `tests/agency-js/agent-tool-trace/`.

- [x] Change expectations first for snapshot-only todos, once-only subagent announcements, shared search headings/source rows, and blue/green start/end styling.
- [x] Use a single presentation table for todo and subagent tool names. Pass the catalog's provider label with tool start/end events. Add the explicit `agentStart` event used by direct subagent announcements.
- [x] Normalize hosted/client sources into common rows. Cover missing/empty/malformed sources, more than five sources, hostile text, full queries, and narrow/plain output.
- [x] Replace the injected failure callback in the integration fixture with real failed calls. Check all four visibility modes and custom failures without generic blocks.

## Task 3: Verify and publish

Files: developer/user tool-output docs and the PR description.

- [x] Update documentation to match the final behavior and lifecycle contract.
- [x] Run `make`, focused unit and Agency-JS tests, `pnpm run fmt:ts`, `pnpm run fmt:ts:check`, `pnpm run lint:structure`, `pnpm run typecheck`, and `git diff --check`, saving output.
- [x] Review the complete change independently, including callback resume and handler safety. Fix actionable issues and rerun affected checks.
- [x] Prepare the verified changes and PR description for publication on PR #1289.
