---
name: agency-agent-docs
description: Developer docs for the Agency agent: the harness and brain split, approval policies, tool-loop guards, reply attachments, the prompt runner, and the reasoning behind agents that write code. Use when changing `agency agent` behavior or how the agent uses tools.
---

# Agents developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/agents/writing-rewrite-agent.md` — The rewrite agent over the writing reviewer: the passes loop, why a reviewer failure is not a clean pass, and how its eval suite shares the reviewer suite's files.
- `docs/dev/agents/agent-brains.md` — How `agency agent` splits into a harness and pluggable brains, and what each half owns.
- `docs/dev/agents/approval-policies.md` — How approval policy rules match, and the matching rules that have caused surprises.
- `docs/dev/agents/tool-loop-guards.md` — The two refusals that stop a model wasting rounds: a repeated call, and an argument that is really tool-call markup.
- `docs/dev/agents/reply-attachments.md` — How a tool hands images back to the model, given that most providers reject image parts in tool results.
- `docs/dev/agents/promptRunner.md` — The small control-flow helper behind `runPrompt`.
- `docs/dev/agents/why-agents-write-code.md` — The argument for letting an agent write and run programs instead of giving it more tools.
- `docs/dev/agents/self-writing-agent.md` — Investigation notes from the experiment behind that argument.
