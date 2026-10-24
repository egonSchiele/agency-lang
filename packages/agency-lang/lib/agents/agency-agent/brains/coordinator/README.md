# The coordinator brain

This directory is one *brain* of the Agency agent: the part that answers a
turn. The harness around it (`agent.agency` and `lib/`) owns the command
line, the REPL, the approval policy handler, the hard stop for a subagent budget trip,
slash-command expansion, and attachment detection. None of that lives here.
`docs/dev/agents/agent-brains.md` explains the split; this file explains how this
particular brain is put together.

Run it with `agency agent` (it is the default) or `agency agent --brain coordinator`.

## What it is

One coordinator LLM reads each turn and either answers itself or calls a
specialist. The specialists are ordinary Agency functions handed to the
coordinator as tools, so "routing" is the model choosing a tool. The research,
oracle, and explorer specialists are handoffs: they continue the coordinator's
conversation, so it sees their steps as well as their answer. The review,
writing, and rewrite specialists run in a thread of their own, and the
coordinator sees only their final answer.

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
- `startTargets`: `code`, `research`, `oracle`, `explorer`, `review`, `writing`, `rewrite`. These
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
the first turn, and calls the LLM with the tool list: the specialists,
`generateImageFile`, the read-only file tools plus `edit` (so a question
that hinges on a few files, or a small change to one of them, never costs
a subagent dispatch), any MCP tools the harness connected, `whatIAmDoing`
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
| `researchAgent` | Reads for the user: web, Wikipedia, URLs, or the bundled Agency docs. A router over two stdlib agents, and a handoff. | `std::agents` |
| `oracleAgent` | Deep-reasoning consult on the slow model slot. A handoff: it continues the coordinator's conversation, so repeated consults see each other. | `std::agents/oracle` |
| `explorerAgent` | Surveys a codebase or topic on the slow model slot. A handoff, like the oracle. | `std::agents/explorer` |
| `reviewAgent` | Reviews code from a message: Agency code through the Agency reviewer, anything else through the general one. | `std::agents/agency/review`, `std::agents/review` |
| `writingAgent` | Reviews prose for readability; reports findings, or applies them when asked. | `std::agents/writing/review` |
| `rewriteAgent` | Rewrites prose from the reviewer's findings and returns the new text. | `std::agents/writing/rewrite` |

Most specialists are thin wrappers over an agent that ships in the standard
library, so users get the same agent in their own programs. A wrapper holds
only what is the agency agent's business: the function the coordinator
calls (a `handoff def` for the researcher, the oracle, and the explorer)
with the parameters the model fills in (`userMsg`, `maxSeconds`, `maxDollars`,
and a routing flag such as `agencyTopic`), the docstring the coordinator
reads to decide when to call it, `announce`, `setMemoryId`, the model slot
from `shared.agency`, the session name, the seconds-to-milliseconds line
(`timeBudget` in `lib/budgets.agency`), and a REPL style text where the
subagent has one. The code subagent is the exception and carries the most
machinery: its own tools, its skill files, the one-shot flag, and the
supervise/verify loop. `brainstorm.agency` and `supervisor.agency` are its
parts, not wrappers, and `lib/autoReview.agency` is its check on the
`.agency` files it wrote.

The oracle and the explorer are handoffs, so a `--agent oracle` or
`--agent explorer` call, which has no conversation to continue, gets a thread
from `oracleTurn` and `explorerTurn` in `coordinator.agency`; the comment
above them says why that is the brain's job and not the stdlib agent's.

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
- `learn`, `presetTools`, and `bundledSkills` test the skill and tool
  learning tools, the preset tools, and the bundled-skill check.

The tests bind `brain.init` / `brain.runTurn` to locals before calling them
with `with approve`; calling a record field with `with approve` directly does
not compile correctly today.

## Adding to this brain

A new specialist is a function in `subagents/`, added to `mainAgentTools`
and, if it should be a `--agent` target, to `startTargets` and the `match`
in `coordinatorRunTurn`. A new brain is a different thing: see
`docs/dev/agents/agent-brains.md` and `brains/simple/README.md`.
