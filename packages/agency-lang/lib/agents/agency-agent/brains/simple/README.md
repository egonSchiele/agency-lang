# The `simple` brain

The smallest brain the Agency agent can run, kept as the worked example of
how a brain is added. Each turn is one LLM call with no tools, in a single
conversation thread that carries over between turns.

Run it with `agency agent --brain simple`.

## What is here

```
simple.agency            the whole brain
tests/simpleTurn.agency  one deterministic turn; checks the grounding reached
                         the system prompt
```

`simpleBrain()` returns the `AgentBrain` record:

- `init(context)` keeps the grounding text (date, working directory,
  `AGENTS.md`) the harness built. That is all the setup this brain needs.
- `runTurn(target, prompt)` opens (or continues) the `simple` thread, sets a
  short system prompt plus the grounding on the first turn, and calls
  `llm(prompt)`. `prompt` may be plain text or text with attachments; the
  LLM call accepts either.
- `startTargets` is empty, so `--agent` accepts only `main`.

Everything else, from the command line and the REPL to the approval policy,
the budget guard, and attachment detection, is the harness's job. A brain
does not see any of it.

## Adding a brain of your own

1. Make a directory under `brains/` with one `.agency` file that exports
   `def <name>Brain(): AgentBrain` (the type is in `brains/brain.agency`).
2. Keep top-level statics free of side effects. The registry imports every
   brain, so every brain's statics run at startup whether or not it was
   selected. Bundled file reads are the one exception (see the coordinator's
   README for the rule and why).
3. Add one line to `allBrains()` in `brains/registry.agency`.
4. Put tests under your brain's own `tests/` directory. Call `init` before
   `runTurn`, the way the harness does.

`docs/dev/agent-brains.md` has the full picture.
