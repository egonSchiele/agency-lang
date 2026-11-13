# The coding agent: its prompt, its tools, and what a dispatch adds

`codingAgent` (`stdlib/agents/coding.agency`) is the stdlib agent that
reads, writes, and runs code. `agency agent` uses it for both of its
coders (`lib/agents/agency-agent/brains/coordinator/subagents/code.agency`),
and any program can import it from `std::agents/coding`. A change to its
prompt or its tools reaches all of them.

## The prompt is short on purpose

The system prompt starts with `CODING_RULES` from
`std::agents/lib/toolkits`: one sentence and five rules about which tool to
use for what. The agent's minimal brain uses the same text. After it comes
a hint for each tool that goes unused without one:
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

`buildTools()` returns the list. Every tool definition is sent with every
request, so the list holds only what `bash` cannot do:

- **Six file and shell tools**, from `codingFileAndShellTools()` in
  `std::agents/lib/toolkits`: `read`, `bash`, `edit`, `write`, `readSpill`,
  and `grepSpill`. There is no `ls`, `glob`, `grep`, or `exec`. The first
  rule in the prompt sends listing and searching to `bash`, and safeBash
  runs a plain `ls`, `grep`, or `cat` with the same narrow approval the
  stdlib tool of that name asks for (`docs/dev/stdlib/safe-bash.md`).
- **One fetch tool**, from `fetchTools()`, and none of the Wikipedia tools
  that `webTools()` adds. `fetchMarkdown` reads a Wikipedia page like any
  other.
- `setAgentCwd` and `getAgentCwd`, `githubAgent`, the memory tools, the
  search tools, `question`, and the agent's skills.

On SWE-bench Verified, a coder with 16 more tools than the six took about
1.8 times the input tokens per task and passed the same number of tasks.
That run could not show what the removed tools are worth on a task where
they help. What it leaves a model without is a pre-approved tool to fall
back on when a bash command cannot be narrowed: `grep -z` raises
`std::bash`, which the recommended policy does not approve, where the
`grep` tool would have been approved.

Three of the six differ from the stdlib functions they wrap:

| Tool | Difference | Why |
|---|---|---|
| `read` | Returns at most 2,000 lines when the model gives no `limit` | A file read whole is sent again with every later request. `read` itself has no default limit, because a program that calls `read("data.csv")` wants the whole file. |
| `write` | `mode` is bound to `"overwrite"` | One fewer parameter for the model to fill in. The rule in the prompt is to use `write` for new files and complete rewrites. |
| `bash` | `safeBash` under another name, with `cwd` bound to the agent's working directory | Models know the name. A command that needs another folder starts with `cd`, which safeBash follows. |

The agent's trace keys its display on the tool's name, so `bash` has its
own row in `lib/stdlib/agentToolTrace.ts`, with the same display as
`safeBash`.

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
- `tests/agency/agents/toolkits.agency`: the coding bundle is exactly the
  six tools, and the agent's whole list is spelled out, so a tool added to
  either shows up as a failing test.
- `lib/agents/agency-agent/brains/coordinator/tests/toolWiring.agency`:
  the coders' tool lists have unique names and each carries `question`.
- `lib/agents/agency-agent/brains/coordinator/tests/toolPresentations.agency`:
  every tool the agent offers has a row in the trace table.
