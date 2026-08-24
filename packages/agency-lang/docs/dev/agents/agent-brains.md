# The Agency agent's harness and brains

The Agency agent (`agency agent`, source in `lib/agents/agency-agent/`) is
split into two parts. The **harness** is everything a user of the command
line sees and everything that keeps the agent safe: flags, the REPL, the
approval policy handler, the per-turn budget guard, slash commands,
attachments. The **brain** is the part that answers a turn. There can be
several brains; `--brain <name>` picks one. This note explains the split,
the record a brain must provide, where the safety boundary sits, and how to
add a brain.

## Why the split exists

We want to try different designs for "how does the agent answer a turn"
(one coordinator LLM with subagents, a single tool-less call, something
else) without rewriting the parts every design shares. Before the split,
the coordinator module owned both the routing *and* pieces of the harness
(the budget guard, slash expansion, attachment detection), so a second
design would have had to copy them. Now the harness owns those, and a brain
is a small record it calls.

## The brain record

A brain is a value of type `AgentBrain` (`brains/brain.agency`):

```
export type BrainContext = {
  interactive: boolean   // false for --print, piped stdin, or a query without -i
  grounding: string      // date, working directory, AGENTS.md block; harness-built
}

export type AgentBrain = {
  name: string           // the --brain value; shown in the header
  description: string    // one line, shown in --help
  startTargets: string[] // valid --agent values; "" (main) is always valid
  init: (BrainContext) -> void raises <*>
  runTurn: (string, string | (string | Attachment)[]) -> string raises <*>
}
```

`init` runs once per session, before any turn. `runTurn(target, prompt)`
answers one turn: `target` is `""` (the brain's main entry) or one of
`startTargets`. For the main target the prompt is an array that may carry
attachments after the text; for a named target it is bare text.

Each brain lives in its own directory under `brains/` and exports one
function, `def <name>Brain(): AgentBrain`. `brains/registry.agency` lists
them all in `allBrains()`; `brainByName` and `brainFlagHelp` are derived
from that list. Two brains ship today: `coordinator` (the default; one
main LLM that routes to code, research, oracle, explorer, and review
subagents) and `simple` (one tool-less LLM call per turn). Each has a
`README.md` describing itself.

## What the harness owns

- `agent.agency`: parses flags, picks the brain, validates `--agent`
  against `brain.startTargets` (`main` means `""`), sets up models, memory,
  and MCP, and then runs either one turn or the REPL, both through
  `runSession` (below).
- `lib/turn.agency`: the selected brain (`setBrain` / `currentBrain`),
  `runSession`, and the harness `runTurn`. The harness `runTurn` runs one
  turn as: parse the budget clue out of the message, then inside the budget
  guard: expand a slash command, and for the main target only, detect and
  attach files the message mentions, then hand the result to
  `brain.runTurn`.
- `lib/repl.agency`: the interactive terminal. It calls the harness
  `runTurn` and never a brain directly.
- `lib/grounding.agency`: builds the grounding text with `groundingText`,
  which calls `loadAgentsMd`.
- `lib/agentName.agency`: `agentNameFor(brain)` returns
  `"agency-agent/<brain name>"`. `main()` passes it to `setAgentName`, so
  every trace is grouped by the brain that produced it.

Selection is a runtime value rather than a separate entry file per brain.
The launcher in `lib/cli/runBundledAgent.ts` hard-codes one entry point, and
a flag lets the same session code, header, and settings serve every brain. `resolveBrainName` picks `--brain`, else the `brain` key in
`settings.json`, else `coordinator`. It checks the runtime shape of the
setting, since the file is hand-editable.

## The safety boundary

The rule, in one sentence: **`runSession` in `lib/turn.agency` owns the
outermost `handle ... with cliPolicyHandler`; `brain.init(...)` and
`brain.runTurn(...)` are called only inside it; and both production paths
(one-shot and the REPL) go through `runSession`.**

```
export def runSession(interactive: boolean, body: () -> void raises <*>) {
  const brain = currentBrain()   // null here is a harness bug and throws
  ...
  const context = buildBrainContext(interactive)
  const handler = policyHandlerFor(interactive)
  handle {
    brain.init(context)
    body()          // the one-shot turn, or the whole REPL
  } with handler
}
```

The `interactive` flag is also threaded into the policy handler
(`cliPolicyHandler(interactive: ...)`). In a one-shot run there is no user
at a terminal, so an interrupt the policy does not decide is rejected with
a reason string instead of prompted. The reason becomes the failing call's
error, and the tool loop feeds it back to the model so it can take another
approach. Before this, an undecided effect in `-p` mode raised a
prompt nobody could answer: the pending prompt starved the event loop and
the process died with exit 13 ("unsettled top-level await").

Why this is enough: handlers in Agency are not try/catch. When a function
raises an interrupt, *every* handler up the chain is consulted, and if any
one of them rejects, the interrupt is rejected. So a brain that wraps its
own work in `with approve` still cannot get past the harness policy. The
policy handler sits outside the brain and gets its vote. `tests/turn.agency`
proves this with a stub brain that approves its own interrupt during `init`
and during two turns and is rejected each time. Note that a function type's
`raises <*>` is a type-checker annotation only; the safety comes from where
the handler is installed, not from the type.

There is a corollary about module statics. `registry.agency` imports every
brain, and Agency initializes the whole import closure at startup
(`docs/dev/compiler/init-topsort.md`), so every registered brain's top-level statics
run whether or not that brain was selected. Two consequences:

1. Brain statics must do nothing effectful, with one exception: bundled
   file reads (the coordinator's system prompts, the code subagent's skill
   files) stay `static const ... with approve`, exactly as before the split.
2. Those reads must *not* move into `init`. `init` runs inside the policy
   handler, and an inner `with approve` cannot get past an outer policy, so
   a read there would prompt the user under `--policy minimal` (which has no
   `std::read` rule) or fail in a non-interactive run. `init` only validates
   that the static reads succeeded, takes the grounding, and does other
   policy-neutral setup.

## Adding a brain

1. Create `brains/<name>/<name>.agency` exporting `def <name>Brain():
   AgentBrain`. Keep statics side-effect free (bundled reads excepted, as
   above). `brains/simple/simple.agency` is the smallest example.
2. Add one line to `allBrains()` in `brains/registry.agency`.
3. Put tests under `brains/<name>/tests/`. Call `init` before `runTurn`,
   the way the harness does. Bind `brain.init` and `brain.runTurn` to
   locals before calling them `with approve`: calling a record field with
   `with approve` directly does not compile correctly today.
4. Add a `README.md` for the brain.

The registry test (`tests/registry.agency`) counts brains, so update its
expected count.

## Known limits

- There is no `/brain` slash command to switch mid-session. A brain owns
  thread state that would not survive the switch, so pick a brain per run.
- Attachments are detected only for the main target. Named targets get bare
  text.
- There are no per-brain slash commands.

## Two compiler bugs met while building this

Both are worked around in the agent and worth their own issues:

- A `match` *expression* inside a block body keeps its value on the enclosing
  function's stack, so a local assigned from it (or an outer `let`) reads
  back `null` inside the block. `oneShotAgent` uses `if (result is
  success(r))` instead.
- `record.field(args) with approve` produces invalid JavaScript. Tests bind
  the field to a local first.
