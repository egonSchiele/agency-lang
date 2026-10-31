# Agent tool display implementation plan

> Use the executing-plans skill for implementation and a fresh reviewer before completion.

**Goal:** Let users follow agent activity without printing routine arguments and file contents twice.

**Architecture:** Extend the existing presentation registry with compact summaries. Keep events independent and reuse the renderer for sanitizing, wrapping, and color. Forward the existing completion duration and debug setting through the agent bridge.

**Tech stack:** TypeScript, Agency, Vitest, deterministic Agency-js fixtures.

**Design:** The user's request and `docs/dev/agents/tool-output.md`.

## Constraints and review focus

- One activity message for reads, local searches, listings, and bundled documentation reads. A failure always prints. A completion taking at least one second prints its duration without file contents.
- Show requested read ranges and search scope. Do not infer actual line counts, resolved paths, or total matches.
- Keep both events for mutations and commands. Show meaningful arguments without write bodies. Keep result previews and explicit command exit codes.
- Debug prints complete supplied arguments and returned values for ordinary and newly compact tools. Existing todo, search, and subagent displays keep their behavior.
- Preserve unknown-tool fallback, control-character sanitizing, narrow-terminal wrapping, and concurrent event independence.
- No runtime callback API changes, stateful pairing, timers, dependencies, or new CLI flags.

## Task 1: Compact presentations

Files: `lib/stdlib/agentToolTrace.ts`, `lib/stdlib/agentToolSummary.ts`, `lib/stdlib/agentToolTrace.test.ts`.

- [x] Add tests for requested ranges, search scope/options, failure visibility, suppressed successful results, slow completion notices, command outcomes, and debug detail.
- [x] Run `pnpm exec vitest run lib/stdlib/agentToolTrace.test.ts`, saving output, and inspect failures.
- [x] Add summary descriptions and declarative registry entries. Reuse the existing renderer.
- [x] Run the same test file and inspect the saved output.

## Task 2: Agent bridge and documentation

Files: `lib/agents/agency-agent/lib/trace.agency`, `lib/agents/agency-agent/lib/args.agency`, `tests/agency-js/agent-tool-trace/`, `docs/dev/agents/tool-output.md`.

- [x] Pass debug and duration through the existing trace events; describe both flags accurately.
- [x] Extend the deterministic fixture to verify compact, quiet, verbose, and debug output through real tool callbacks.
- [x] Update the dev doc with principles, tool choices, examples, and extension instructions.
- [x] Run formatting, `make`, targeted unit tests, the single Agency-js fixture, and structural lint. Save outputs.
- [x] Review the diff independently and resolve material findings.

## Verification

75 formatter tests and the single Agency-js trace fixture passed. The full `make`, TypeScript checks, structural lint, and formatting passed. Independent review found an explicit working-directory distinction; its regression test now passes. Test output is saved under `/tmp/agency-tool-display-*.log`.
