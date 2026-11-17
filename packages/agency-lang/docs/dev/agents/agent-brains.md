# The Agency agent: `agencyAgent` and the `agency agent` harness

The Agency agent comes in two parts.

- **`agencyAgent`** in `std::agents/agency` (`stdlib/agents/agency.agency`)
  answers one message. Any program can call it from code or give it to a
  model as a tool. It reads none of the user's files, installs no handler,
  and prints nothing.
- **The harness** is `agency agent` on the command line
  (`lib/agents/agency-agent/`). It owns everything a person at the terminal
  sees and everything that keeps the run safe: flags, the REPL, slash
  commands, saved sessions, settings, presets, the approval policy handler,
  and the reads of the user's own files. It calls `agencyAgent` once per
  turn and passes in what only it has.

This note covers the function and its parameters, how settings reach the
subagents, what the harness passes in, and where the safety boundary sits.

## The function

```
@guarded(cost: maxCost, time: maxTime)
export def agencyAgent(
  task: string,
  context: string = "",
  brain: AgencyAgentBrain = "coordinator",
  maxCost: number = $50.00,
  maxTime: number = 30m,
  model: string = "",
  provider: string = "",
  reasoningModel: string = "",
  reasoningProvider: string = "",
  routerModel: string = "",
  routerProvider: string = "",
  extraTools: AgentExtraTools = {},
  attachments: Attachment[] = [],
): Result<string>
```

- `task` is the message. With attachments, the brain gets
  `[task, ...attachments]`.
- `context` is extra text, such as the user's instructions. Each brain adds
  it as a system message that expires with the call, and each subagent
  wrapper passes it to its stdlib agent.
- `brain` picks one of five brains (`stdlib/agents/brains/`):
  - `coordinator`, the default: one model that answers itself or hands
    the turn to the code, Agency code, research, oracle, explorer, review,
    writing, and rewrite subagents.
  - `minimal`: one coder with four tools and a short prompt, for
    benchmarks and sandboxed runs.
  - `simple`: one LLM call with no tools of its own.
  - `spawntest`: a trial. The minimal brain, plus a tool that starts
    another agent as a process of its own. See "The spawntest brain" below.
  - `scripttest`: a trial. The minimal brain, plus tools that write and
    run a short Agency program in place of a node or shell script.
    See "The scripttest brain" below.

  `agencyAgentBrains()` lists them with a one-line description each.
- `maxCost` and `maxTime` are the budget for the whole call. A negative
  value means no limit, because `guard` pushes no guard for a negative
  limit (`pushGuardImpl` in `lib/stdlib/thread.ts`). `null` is not
  accepted: `guard` throws when both limits are `null`.
- `model` and `provider` pick the main model, which the coder, the
  researchers, and the reviewers run on. Empty means the ambient model.
- `reasoningModel` and `reasoningProvider` pick the model for the
  coordinator's own calls, the oracle, and the explorer. Empty means the
  main model.
- `routerModel` and `routerProvider` pick the decision model that can send
  a plain message straight to the coder or the researcher
  (`docs/dev/agents/agent-router.md`). Empty means no routing.
- `extraTools` is a record. `main` is added to the tools of the model that
  answers the turn, and `coder` to the tools of the two coders. Only the
  coordinator brain has coders.

The function has one mode. Nothing in it asks whether a person is present.
It offers no background job tools, because a job belongs to the run and is
stopped when the run ends, and in a web server the run usually ends when the
call returns. A caller whose run stays alive passes the job tools in
`extraTools`.

`agencyAgent` is a plain `def`, not a handoff. Called from code, its brains
run on the caller's active thread, so a second call continues the first
one's conversation. Each brain adds its own prompt with
`ensureSystemMessage`, so a thread holds it once. Called as a tool, it
starts on a fresh thread, as every ordinary tool does
(`docs/dev/runtime/threads.md`).

### Progress events

The function prints nothing. Callers follow it through the runtime
callbacks (`onToolCallStart`, `onToolCallEnd`, `onLLMCallEnd`, and the
rest), and through `emit` from `std::statelog`:

- Each subagent wrapper emits
  `{ type: "agencyAgent.subagentStart", agent, message }` when it starts.
- The coordinator emits
  `{ type: "agencyAgent.routerFailed", model, provider, error }` when the
  router model fails, once per router model (`failureNotice` in
  `stdlib/agents/brains/coordinator/router.agency`).

## How settings reach the subagents

`agencyAgent` builds one `AgentSettings` record
(`stdlib/agents/brains/settings.agency`) from its parameters. The subagent
wrappers in `stdlib/agents/brains/coordinator/` take it as their first
parameter:

```
export handoff def oracleAgent(
  settings: AgentSettings,
  userMsg: string,
  maxSeconds: number | null = null,
  maxDollars: number | null = null,
): Result<string>
```

`settings` comes first because Agency refuses a parameter with no default
after a defaulted one (AG6039). `coordinatorTools(settings, turnStart)`
binds it on each wrapper with `.partial(settings: settings)`. A bound
parameter is left out of the tool's schema, so the model sees only
`userMsg` and the budget parameters. `tests/agency/agents/brainCoordinatorTools.agency`
checks this.

## What the harness passes in

Paths in this section are relative to `lib/agents/agency-agent/`.

`answerTurn` in `lib/answer.agency` builds each turn's call:

- `context` is the global instructions, `globalInstructionsText()`, and
  nothing else. `context` reaches every subagent, including the writing
  reviewer and the rewriter, which read it as part of the task their prose
  was written for.
- In the REPL, for the coordinator brain, `addReplStyle()` adds one line on
  how to format a reply for the terminal to the conversation thread, as the
  grounding is added. The minimal and simple brains get no such line. The
  coordinator, the coders, and the researcher run on that thread and see
  it. The review, writing, and rewrite subagents open their own thread and
  do not. A one-shot run prints plain text and gets no such line. The
  stdlib brains say nothing about how a reply is displayed, because a
  caller such as a web back end shows it some other way.
- The main model is left empty: `pickModelsForAgent` already set the
  ambient one. The reasoning and router models come from the resolved
  slots. `routerModelFor()` passes no router model when the harness
  rewrote the message, such as a slash command that became its skill's
  text.
- `maxCost` and `maxTime` are `-1`. A whole-agent limit comes from
  `--max-cost` and `--max-time`, which the runtime enforces as a root
  budget.
- `extraTools.main` is `cliTools()` (`lib/cliTools.agency`) for the
  coordinator brain, and nothing for the other two. It holds the tools that
  differ per user (learned tools, saved tools, Claude Code skills, MCP
  tools), then the CLI's own (`learnSkill`, `writeToolFor`, the presets
  skill and tools, `useLlmOptions`, `learnTools`, `searchSessions`), then,
  in the REPL, the job tools and the readers for saved output.
- `extraTools.coder` is `sessionJobTools()`: the job tools in the REPL, and
  nothing in a one-shot run.

The grounding block goes on the conversation thread, not in `context`. It
holds the session facts, the date, the working directory, and the project
`AGENTS.md`. `runSession` builds it once with `groundingText` and stores it
with `setGrounding` (`lib/grounding.agency`). Each turn adds that stored
string with `ensureSystemMessage`. Two reasons:

- A system message that stays on the thread is cached by the provider. A
  message that expires is sent again, uncached, every turn.
- The text holds the date, the directory, and the models.
  `ensureSystemMessage` matches by exact text, so a block rebuilt every
  turn would be added a second time whenever one of those changed.

A moved working directory is handled by `withProjectContextIfMoved`, which
puts the new folder's block above the next message. The `--agent code`
start target keeps its own project block the same way, in
`lib/startTargets.agency`.

The `--agent` start targets (`code`, `agencyCode`, `research`, `oracle`,
`explorer`, `review`, `writing`, `rewrite`) call one stdlib wrapper
directly, through `runStartTarget`. Only the coordinator brain has them.

The harness prints the subagent start line and the router failure line from
an `onEmit` callback in `lib/trace.agency`.

## The conversation thread

No brain opens a `thread` block, so a turn runs on the run's active thread.
Before and after each turn, `runTurn` in `lib/turn.agency` records that
thread's id with `setConversationThread` (`lib/resume.agency`). It records
before the turn so that a turn the user cancels still leaves the id behind. Compaction,
the context percentage, the session title, the resume transcript, and
`searchSessions` read the thread the id names
(`docs/dev/agents/agent-sessions.md`, `docs/dev/agents/agent-compaction.md`).

## The safety boundary

The rule, in one sentence: **`runSession` in `lib/turn.agency` owns the
outermost `handle ... with cliPolicyHandler`, every turn is answered inside
it, and both production paths (one-shot and the REPL) go through
`runSession`.**

```
export def runSession(interactive: boolean, body: () -> void raises <*>) {
  setGrounding(groundingText(_brainName))
  const handler = policyHandlerFor(interactive)
  handle {
    checkCliBundles()
    body()          // the one-shot turn, or the whole REPL
  } with handler
}
```

`agencyAgent` installs no handler of its own. The only reads it approves are
of the files packaged with Agency, through `agentPrompt` and `agentSkill`,
which is what every stdlib agent does. So the harness policy decides every
interrupt a turn raises. `tests/turn.agency`
(`sessionPolicyDecidesTheAgentsInterrupts`) runs a turn whose model writes a
file under the CLI policy, and the write is rejected.

Handlers in Agency are not try/catch. When a function raises an interrupt,
every handler up the chain is consulted, and if any one of them rejects,
the interrupt is rejected. So code inside a turn that wraps its own work in
`with approve` still cannot get past the policy handler.

The `interactive` flag is threaded into the policy handler
(`cliPolicyHandler(interactive: ...)`). In a one-shot run there is no user
at a terminal, so an interrupt the policy does not decide is rejected with
a reason the model reads, instead of a prompt nobody can answer.

## Statics read the user's files only in the harness

A `static const` runs once per process, when its module loads, and every
module in the import closure runs its statics at startup
(`docs/dev/compiler/init-topsort.md`). A static in a stdlib module that read
the user's files would read them in every program that imports the module.
So the reads of the user's own files stay in the harness's modules:

- the global `AGENTS.md` (`lib/globalInstructions.agency`),
- the Claude Code skills and `.claude/commands` (`lib/claudeSkills.agency`,
  `lib/commandPalette.agency`),
- the bundled presets skill (`lib/cliTools.agency`).

The stdlib modules' statics read only the packaged prompts and skills.
`lib/stdlib/agentBrainStatics.test.ts` fails on a static in
`stdlib/agents/brains/` or `stdlib/agents/agency.agency` that calls any
function not on the test's list. A function goes on the list only after
someone has read it and everything it calls. A tool list that includes
`searchTools` is built inside a function, never in a static, because
`searchTools` reads the search API keys from the environment.

The grounding is built in `runSession` before the policy handler is
installed, so reading the project's `AGENTS.md` never prompts. A block built
later, for a moved folder or for a coder started with `--agent code`, is
read inside a turn. So the handler `runSession` installs is the policy
handler wrapped in `approvingInstructionReads`: while `projectContextText`
reads the instruction files, a `std::read` of `AGENTS.md` or `CLAUDE.md`
that no rule decides is approved instead of asking the user. A `reject`
rule still wins.

## The spawntest brain

A trial of starting agents from the agent. `spawntestBrain` in
`stdlib/agents/brains/spawntest.agency` is the minimal brain with one more
tool, `startAgent(task, name)`. The tool calls `spawn`
(`docs/dev/runtime/spawn.md`) on `stdlib/agents/programs/task.agency`,
which runs `agencyAgent` with the minimal brain on the one task, prints
the reply, and exits.

- **Approving a start.** `startAgent` raises `std::spawn` and installs no
  handler, so the session's policy decides, or the user is asked. The
  prompt shows `maxCost` and `maxTime` as `null`, yet the agent does stop:
  `task.agency` passes no budget, so `agencyAgent`'s defaults of $50 and
  30 minutes apply. `std::spawn` pins `dir` and `filename` in an "always
  approve when" rule, and both are the same for every start, so that one
  answer approves every later start, whatever its task.
- **The started agent's rules.** `startAgent` passes no policy, and the
  model cannot give one. Every question the started agent raises, a file
  read included, waits for a person to answer with `agency attach`.
- **The model.** A started program cannot see the ambient model of the
  program that started it. `startAgent` passes `settings.model` and
  `settings.provider` as flags, and `agency agent` fills those two in for
  this brain only (`namedMainModel` in
  `lib/agents/agency-agent/lib/answer.agency`). A caller that sets
  neither gets the started program's own configured model.
- **The context.** `settings.context` goes to the started agent as the
  first message of its conversation, through `spawn`'s `messages`. It is
  kept out of the arguments, which the process list shows to every user of
  the machine. The task is in the arguments.
- **Nothing comes back.** The tool returns the process id, the name, and
  the output file, and the reply goes to that file.
- **The install folder must be writable.** `agency run` compiles
  `task.agency` next to its source and keeps its build manifest in the
  package folder. In an install the user cannot write to, such as one made
  with `sudo npm install -g`, the manifest is never saved, so every start
  tries to compile again and fails. The `task.js` the package ships is not
  used.

## The scripttest brain

A trial of having the agent write its quick checks in Agency. In one
session, the coordinator ran five `node -e` scripts to read a JSON file
and call a function. Each script asked one question for the whole script,
so the user had to read the script to answer it. An Agency program asks
about each file it reads or writes and each command it runs, through the
same handlers as the agent's other tools, so the user answers questions
about what the program does instead of reading it.

`scripttestBrain` in `stdlib/agents/brains/scripttest.agency` is the
minimal brain with two more tools and a short primer on Agency in its
system message:

- `runAgency(source)` type-checks a program the model wrote and runs it.
- `agencyScript(task)` hands a task to the stdlib Agency writer, which
  writes and checks the program, then runs it.

The primer tells the model to write a quick check in Agency instead of
`node -e`, `python -c`, or a shell script, and to use those only when the
question is about Node or Python themselves. It holds one example program
and a list of the mistakes models make most often in Agency, such as
`if (count)` on a number or `readFile`. It is about 2 KB.

It is built on the minimal brain so that it can be benchmarked against
it: the two differ only in the two tools and the primer.

- **Why a primer and not the tutorial.** The full tutorial is about 34 KB,
  and on the main thread it is sent with every model call, whether or not
  the call writes Agency. Without any Agency in the main context, the model
  writes Python every time it is free to choose. The primer is the
  smallest text that still moves that choice. The tutorial stays in the
  writer's own system prompt, where `agencyScript` uses it.
- **runAgency checks first.** It runs `typecheck(strict: true)`, which also
  reports the imports and JavaScript names the separate process refuses.
  When the program has errors, they come back as one line each and nothing
  runs. The strict check does not catch every undefined name: it accepts
  `keys(x)` with no import of `keys`, which then fails at run time.
- **agencyScript is a subagent, not a handoff.** The writer,
  `agencyCodingAgent`, works on a thread of its own with `strict: true`
  and a budget of $1 and 5 minutes. It does not see the conversation, so
  the task has to name every file and say what to return. The tool returns
  the result and the program's source, so the model can save the program
  to a file. If the writer gives up, its failure comes back and nothing
  runs.
- **The run.** Both tools call `runCode` with the agent working directory
  as `cwd` and as `dir`. So a relative path names a file there, and a
  program can import an Agency file there, such as
  `import { solve } from "./solve.agency"`. `runCode` raises `std::run` to
  start the process. Every effect the program raises goes to the session's
  handlers (`docs/dev/runtime/subprocess-ipc.md`). The tool returns what
  `main` returns. Printed output does not come back to the model.
- **A handler inside the program approves nothing on its own.** Models
  write `ls(dir) with approve` into these programs. The program's own
  approval still sends the interrupt on to the session's handlers
  (`docs/dev/runtime/subprocess-ipc.md`, "The distributed handler chain"),
  and the agent's policy handler always answers: with a saved rule, with a
  rejection in a one-shot run, or by asking the user
  (`cliPolicyHandler` in `stdlib/policy.agency`). It never returns "no
  answer", which is the one case where the program's approval would stand.
- **A question inside the program.** The agent's handler asks the user
  inside the handler, so the program waits for the answer and does not
  pause. A host whose handlers leave an interrupt undecided gets the usual
  subprocess pause: the child saves a checkpoint and exits, and resuming
  runs it again from that point in a new process.
- **Nothing forces the tool.** The model can still run `node -e`, because
  some checks are about Node itself, such as how Node resolves a package.
  Whether the model follows the message is the question the trial answers.
- **The harness treats it as the minimal brain.** `agency agent` gives it
  no CLI tools, no REPL style line, no session facts rule, and no
  `--agent` start targets, as for `minimal`.

## Adding a brain

1. Create `stdlib/agents/brains/<name>.agency` exporting
   `def <name>Brain(prompt, settings: AgentSettings, extraTools: any[]): Result<string>`.
   Read no user file in a static. `stdlib/agents/brains/simple.agency` is
   the smallest example.
2. Add it to `AgencyAgentBrain`, to the `match` in `agencyAgent`, and to
   `agencyAgentBrains()` in `stdlib/agents/agency.agency`.
3. Add a test under `tests/agency/agents/`, as `brainSimple.agency` does.

## Known limits

- There is no `/brain` slash command to switch mid-session. Pick a brain
  per run.
- Attachments are detected only for the main target. Named targets get bare
  text.
- A library user who has memory on gets the coordinator's memory calls: it
  sets the memory id to `"main"` and passes `memory: true`, and the
  research wrapper offers the memory tools. Memory is off in `agency agent`.

## A compiler bug met while building this

A `match` *expression* inside a block body keeps its value on the enclosing
function's stack, so a local assigned from it (or an outer `let`) reads
back `null` inside the block. `oneShotAgent` in `agent.agency` uses
`if (result is success(r))` instead.
