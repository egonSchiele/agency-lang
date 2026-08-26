# The coordinator brain

This directory is one *brain* of the Agency agent: the part that answers a
turn. The harness around it (`agent.agency` and `lib/`) owns the command
line, the REPL, the approval policy handler, the per-turn budget guard,
slash-command expansion, and attachment detection. None of that lives here.
`docs/dev/agents/agent-brains.md` explains the split; this file explains how this
particular brain is put together.

Run it with `agency agent` (it is the default) or `agency agent --brain coordinator`.

## What it is

One coordinator LLM reads each turn and either answers itself or calls a
specialist. The specialists are ordinary Agency functions handed to the
coordinator as tools, so "routing" is the model choosing a tool. Each
specialist runs in its own conversation thread, so the coordinator sees only
the specialist's final answer, not its inner steps.

## The files

```
coordinator.agency      the brain record: init, the main LLM call, routing
prompts/                system prompts (main-large.md, main-small.md, and the
                        code subagent's code.md, plan.md, design.md, oneShot.md)
subagents/              the specialists (one file each) plus their helpers
tests/                  Agency execution tests for this brain
```

## `coordinator.agency`

`coordinatorBrain()` returns the record the registry hands to the harness:

- `name: "coordinator"`, the `--brain` value.
- `startTargets`: `code`, `research`, `oracle`, `explorer`, `review`, `writing`. These
  are the names `--agent <name>` may route the starting prompt to directly.
  `--agent main` (or no flag) goes through the coordinator.
- `init(context)`: runs once per session, inside the harness policy handler.
  It checks that the two system prompts were read, keeps the grounding text
  (date, working directory, `AGENTS.md`) to splice into the system prompt,
  and tells the code subagent whether it is running one-shot (no human to
  ask, so it must drive to a finished artifact).
- `runTurn(target, prompt)`: a named target calls that specialist with the
  message text; the main target (`""`) calls `mainAgent`, which may receive
  attachments alongside the text.

`mainAgent` opens (or continues) the `main` thread, sets the system prompt on
the first turn, and calls the LLM with the tool list: the five specialists,
`generateImageFile`, any MCP tools the harness connected, `whatIAmDoing`
(progress reporting), and `elapsedTime` anchored to the turn start.

The system prompt is chosen by the `prompt` capability: `main-large.md` by
default, `main-small.md` for the compact profile.

**Statics rule.** The two prompt reads are `static const ... with approve`.
They run when the module is imported, before the policy handler exists,
which is what lets `--policy minimal` start without prompting about the
agent's own files. `init` only checks that they succeeded. Do not move
bundled reads into `init` or `runTurn`: those run inside the policy handler,
and an inner `with approve` cannot get past an outer policy.

## The specialists (`subagents/`)

| Tool | What it does | Where the agent really lives |
|---|---|---|
| `codeAgent` | Anything that touches code or the file system: reading, writing, editing, running commands, Agency questions. Triages the task; a complex task gets a plan, a brainstorm of directions, a supervised solve, and a verification round. | here (`code.agency`, with `brainstorm.agency` and `supervisor.agency`) |
| `researchAgent` | Reads for the user: web, Wikipedia, URLs, or the bundled Agency docs. A router over two stdlib agents. | `std::agents` |
| `oracleAgent` | Deep-reasoning consult on the slow model slot; repeated consults share a session. | `std::agents/oracle` |
| `explorerAgent` | Surveys a codebase or topic on the slow model slot; shared session. | `std::agents/explorer` |
| `reviewAgent` | Reviews Agency code: snippets from a message, or the files the code agent just wrote. | `std::agents/agency/review` |
| `writingAgent` | Reviews prose for readability; reports findings, or applies them when asked. | `std::agents/writing/review` |

Most specialists are thin wrappers that add what is the agent's business
(the user's chosen model slots, a shared session) to an agent that ships in
the standard library, so users get the same agent in their own programs. The
code subagent is the exception and carries the most machinery: its own
tools, its skill files, the one-shot flag, and the supervise/verify loop.

## Tests (`tests/`)

Run one with `pnpm run agency test lib/agents/agency-agent/brains/coordinator/tests/<name>.agency`.

- `agentTurn` calls the brain record directly (`init`, then `runTurn`) with
  the deterministic LLM provider and checks the reply, that the grounding
  reached the system message, and that the bundled prompt text did too. Its
  other nodes cover model-slot selection and the header.
- `attachmentsTurn` hands the brain a real image attachment and checks it
  reaches the model; detection and modality filtering are tested in the
  harness (`tests/turn.agency`), not here.
- `brainstorm`, `supervisor`, `toolWiring` test the code subagent's helpers.

The tests bind `brain.init` / `brain.runTurn` to locals before calling them
with `with approve`; calling a record field with `with approve` directly does
not compile correctly today.

## Adding to this brain

A new specialist is a function in `subagents/`, added to `mainAgentTools`
and, if it should be a `--agent` target, to `startTargets` and the `match`
in `coordinatorRunTurn`. A new brain is a different thing: see
`docs/dev/agents/agent-brains.md` and `brains/simple/README.md`.
