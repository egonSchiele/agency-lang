# The coding agent: its prompt, its tools, and what a dispatch adds

`codingAgent` (`stdlib/agents/coding.agency`) is the stdlib agent that
reads, writes, and runs code. `agency agent` uses it for both of its
coders (`lib/agents/agency-agent/brains/coordinator/subagents/code.agency`),
and any program can import it from `std::agents/coding`. A change to its
prompt or its tools reaches all of them.

## The prompt is short on purpose

The system prompt is one sentence, four rules about which tool to use for
what, and a hint for each tool that goes unused without one:
`PROGRESS_NOTE` (a sentence beside each tool call, which the agent's trace
prints), `SAVE_DRAFT_HINT` (`saveDraft`), and `askUserHint()` (the
`question` tool), which is added per call and is empty when nobody can
answer.

Every rule in the prompt is sent with every request, and rules have not
bought correct answers when measured. On SWE-bench Verified, a prompt
with rules about matching an output contract, planning, and not
re-checking, plus a reminder appended to every task, took about twice
the input tokens per task and passed the same number of tasks.

Before adding a rule to the prompt, measure it.
`docs/dev/evals/terminal-bench.md` describes how to run a suite.

## The tools

`buildTools()` returns the list. The file and shell tools come from
`codingFileAndShellTools()` in `std::agents/lib/toolkits`. It carries the
same tools as `writableFileTools()` and `shellTools()` together, built
from the same helpers, with three differences:

| Tool | Difference | Why |
|---|---|---|
| `read` | Returns at most 2,000 lines when the model gives no `limit` | A file read whole is sent again with every later request. `read` itself has no default limit, because a program that calls `read("data.csv")` wants the whole file. |
| `write` | `mode` is bound to `"overwrite"` | One fewer parameter for the model to fill in. The rule in the prompt is to use `write` for new files and complete rewrites. |
| `bash` | `safeBash` under another name, with `cwd` bound to the agent's working directory | Models know the name. A command that needs another folder starts with `cd`, which safeBash follows. |

The agent's trace keys its display on the tool's name, so `bash` has its
own row in `lib/stdlib/agentToolTrace.ts`, with the same display as
`safeBash`.

`write` does not create missing parent folders. A write into a folder
that does not exist fails inside `write`'s destructive region, and the
tool loop then removes `write` from the conversation
(`docs/dev/agents/tool-loop-guards.md`).

## What a dispatch adds

`dispatchContext` in `code.agency` builds the context the coder gets
beside the task:

- The user's own instructions (`AGENTS.md`), always.
- A sentence about formatting the reply for a terminal, in an interactive
  session only. A one-shot run (`agency agent -p`) has no reader for a
  formatted reply.

A one-shot run gets no other note. It has no `question` tool and no hint
about one, because nobody is at the terminal to answer
(`docs/dev/stdlib/asking-the-user.md`).

## Tests

- `tests/agency/agents/codingTools.agency`: the shell tool is named
  `bash`, `read` stops at 2,000 lines, and `write` takes no `mode`.
- `tests/agency/agents/toolkits.agency`: the coding bundle has the same
  tools as `writableFileTools()` and `shellTools()` together.
- `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency`:
  the coders' tool lists have unique names and each carries `question`.
- `lib/agents/agency-agent/brains/coordinator/tests/toolPresentations.agency`:
  every tool the agent offers has a row in the trace table.
