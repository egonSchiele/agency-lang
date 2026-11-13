# The `minimal` brain

One coder with five tools and a short prompt. Each turn is one tool loop in
a single conversation thread that carries over between turns. There is no
coordinator and there are no subagents.

Run it with `agency agent --brain minimal`.

## What it is for

Benchmarks and sandboxed runs. Every tool definition and every line of the
system prompt is sent with every request, so on a long coding task a short
list costs much less than the coordinator's. On SWE-bench Verified, the
tools the coordinator's coder carries beyond these five took about 1.8
times the input tokens per task and passed the same number of tasks.

It gives up what those tools do: GitHub, web fetch and search, memory,
skills, background jobs, asking the user, and saving a draft answer for a
run that hits its budget. Use the coordinator when a task needs any of
them.

It does not give up safety. `bash` is `safeBash` under another name, so
every command is still planned, raises its interrupts, and is answered by
the same policy handler as in any other brain.

## What is here

```
minimal.agency            the whole brain
tests/minimalTurn.agency  one scripted turn that runs a bash call, and the
                          tool list
```

- The tools come from `minimalCodingTools()` in `std::agents/lib/toolkits`:
  `read`, `bash`, `edit`, `write`, and `readSpill`. `read`, `bash`, and
  `write` are the same shaped tools the stdlib coding agent uses.
- The prompt is one sentence and five rules. The first rule sends listing
  and searching to `bash`, because this brain has no `ls`, `glob`, or
  `grep` tool.
- `startTargets` is empty, so `--agent` accepts only `main`.

`docs/dev/agents/agent-brains.md` has the full picture of what a brain is
and what the harness does around it.
