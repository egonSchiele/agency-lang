---
name: agency-agent-docs
description: Developer docs for the Agency agent: the harness and brain split, approval policies, tool-loop guards, reply attachments, the prompt runner, and the reasoning behind agents that write code. Use when changing `agency agent` behavior or how the agent uses tools.
---

# Agents developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/agents/writing-rewrite-agent.md` — The rewrite agent over the writing reviewer: the passes loop, why a reviewer failure is not a clean pass, and how its eval suite shares the reviewer suite's files.
- `docs/dev/agents/agent-sessions.md` — Save and resume for `agency agent`: a checkpoint between turns, why it is taken from TypeScript after the turn's frames return, where the restore runs, and what a restore does not bring back.
- `docs/dev/agents/agent-brains.md` — How `agency agent` splits into a harness and pluggable brains, and what each half owns.
- `docs/dev/agents/harness-and-model.md` — How to divide credit between harness and model, the six tiers a fix can land in, and what a harness genuinely cannot do.
- `docs/dev/agents/harness-guidelines.md` — The prescriptive companion: must-dos and must-nots for building and changing the agent harness.
- `docs/dev/agents/approval-policies.md` — How approval policy rules match, and the matching rules that have caused surprises.
- `docs/dev/agents/subagent-budgets.md` — How a stated deadline reaches a subagent as a tool parameter, what happens when its guard trips, and why the harness no longer guards the whole turn.
- `docs/dev/agents/tool-loop-guards.md` — The three refusals that stop a model wasting rounds: a repeated call, an argument that is really tool-call markup, and a call identical to one already rejected.
- `docs/dev/agents/reply-attachments.md` — How a tool hands images back to the model, given that most providers reject image parts in tool results.
- `docs/dev/agents/promptRunner.md` — The control-flow helper behind `runPrompt`, and the rule that tool-loop decisions must be durable: made inside a step, persisted in `runnerState`.
- `docs/dev/agents/why-agents-write-code.md` — The argument for letting an agent write and run programs instead of giving it more tools.
- `docs/dev/agents/self-writing-agent.md` — Investigation notes from the experiment behind that argument.
