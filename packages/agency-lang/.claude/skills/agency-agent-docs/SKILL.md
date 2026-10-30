---
name: agency-agent-docs
description: Developer docs for the Agency agent: the harness and brain split, approval policies, tool-loop guards, reply attachments, the prompt runner, and the reasoning behind agents that write code. Use when changing `agency agent` behavior or how the agent uses tools.
---

# Agents developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/agents/writing-rewrite-agent.md` — The rewrite agent over the writing reviewer: the passes loop, why a reviewer failure is not a clean pass, and how its eval suite shares the reviewer suite's files.
- `docs/dev/agents/claude-skills.md` — The user's Claude Code skills in `agency agent`: the folders (`~/.claude/skills`, then `.claude/skills` up to the repository root) and where the walk stops, one scan per folder with `scanClaudeSkills`, precedence by name before the frontmatter switches apply, the one `skill` tool with its listing budget, the slash commands, which frontmatter fields are supported and which are not, why nothing in the agent policy can stop the startup scans while a root policy can, the recommended read rule for the skill folders, and what a resumed session sees.
- `docs/dev/agents/agent-sessions.md` — Save and resume for `agency agent`: a checkpoint between turns, why it is taken from TypeScript after the turn's frames return, where the restore runs, and what a restore does not bring back.
- `docs/dev/agents/agent-presets.md` — Presets for `agency agent`: the rule table, the `ModelRequest` that startup, `/model`, and `/preset` all resolve, the preset layer, the `llmOptions` block beside the model and why a switch replaces it whole, why presets are read once at startup, and how the coordinator's tools write `settings.json`.
- `docs/dev/agents/learned-catalog.md` — The skills a user taught the agent and the tools it wrote: `designSkill` and `designTool` pointed at the agent home as the coordinator's `learnSkill` and `writeToolFor`, the `learned_` prefix and name cap, and `learnedExtras()`, the per-dispatch list a subagent adds to its tools.
- `docs/dev/agents/agency-writer-prompt.md` — How the Agency writer learns the language: the tutorial in its system prompt and how its standard library section was chosen, the brief `path - description` docs listing and why the description stays, formatting an accepted draft in the harness, and how to measure a change.
- `docs/dev/agents/agent-brains.md` — How `agency agent` splits into a harness and pluggable brains, and what each half owns.
- `docs/dev/agents/harness-and-model.md` — How to divide credit between harness and model, the six tiers a fix can land in, and what a harness genuinely cannot do.
- `docs/dev/agents/harness-guidelines.md` — The prescriptive companion: must-dos and must-nots for building and changing the agent harness.
- `docs/dev/agents/herdr.md` — Reporting a `repl()` program to Herdr, the terminal workspace manager: the opt-in `herdrName` that `agency agent` sets, the idle, working, and blocked states and where the REPL sends each, the saved session and its `agency agent --resume` command, why `seq` follows the clock, the one-at-a-time queue, why a refused resume command is dropped and the state sent again, the `globalThis` hook that keeps `herdr.ts` out of the browser bundle, and what is not reported.
- `docs/dev/agents/approval-policies.md` — How approval policy rules match, and the matching rules that have caused surprises.
- `docs/dev/agents/subagent-budgets.md` — How a stated deadline reaches a subagent as a tool parameter, the `@guard` decorator that enforces it and answers its own trip, the rule in `_budgetOutcome` that makes whatever reached the guard (a finished answer or a saved draft) a success and a trip with nothing a failure, how a draft reaches the guard, the `sleep()` gap, and why the harness no longer guards the whole turn.
- `docs/dev/agents/tool-loop-guards.md` — The three refusals that stop a model wasting rounds: a repeated call, an argument that is really tool-call markup, and a call identical to one already rejected.
- `docs/dev/agents/tool-output.md` — Agent tool traces: todo lists, search queries, generic results, failure events, and shared sanitizing and wrapping.
- `docs/dev/agents/reply-attachments.md` — How a tool hands images back to the model, given that most providers reject image parts in tool results.
- `docs/dev/agents/promptRunner.md` — The control-flow helper behind `runPrompt`, and the rule that tool-loop decisions must be durable: made inside a step, persisted in `runnerState`.
- `docs/dev/agents/research-loop.md` — The researcher's single pass: why an empty answer is asked for once more with no tools, why a second empty answer is a failure the caller sees, why there is no grounding review, and why the research tools carry no `print`.
- `docs/dev/agents/why-agents-write-code.md` — The argument for letting an agent write and run programs instead of giving it more tools.
- `docs/dev/agents/why-the-agent-writes-tools.md` — What tools are for: what a tool gives that a skill cannot, tool sharpening, what each tool costs in context and how that squares with a minimal harness like Pi, and when a tool is not worth writing.
- `docs/dev/agents/self-writing-agent.md` — Investigation notes from the experiment behind that argument.
