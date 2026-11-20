# The Agency agent as a stdlib function

Date: 2026-11-14. Status: design agreed in conversation with the owner, and revised the same day after review. No owner decisions are open.

## Background

### What the Agency agent is today

`agency agent` is the agent that ships with Agency. Its source is in `lib/agents/agency-agent/`. It is split into two parts, described in `docs/dev/agents/agent-brains.md`:

- The **harness** is everything a person at the command line sees: flags, the REPL, slash commands, saved sessions, settings, presets, and the approval policy handler.
- A **brain** is the part that answers one turn. Three brains ship: `coordinator` (one main LLM that routes to subagents), `minimal` (one coder with four tools), and `simple` (one LLM call with no tools).

The coordinator's subagents already live in the stdlib. `std::agents/coding`, `std::agents/researcher`, `std::agents/oracle` and the others are ordinary exported functions. A user can call them from code or give them to an `llm()` call as tools.

### What is missing

A user cannot do the same with the Agency agent itself. This is what we want them to be able to write:

```
import { agencyAgent } from "std::agents/agency"

node main() {
  const reply = agencyAgent("Add a --json flag to the report command", maxCost: $5.00)
  print(reply)
}
```

They should also be able to hand it to a model:

```
const answer = llm(prompt, tools: [agencyAgent])
```

### Why the brains cannot be moved as they are

A brain looks like the function we want, but it is not self-contained. It reads its settings from module-level variables that `main()` in `agent.agency` fills in before the first turn. Here is each one, and where it lives today:

| What the brain reads | Where it comes from |
|---|---|
| The reasoning model and the router model | `getSlowModel()`, `getRouterModel()` in `shared.agency`, set by `pickModelsForAgent` |
| Date, working directory, project `AGENTS.md`, and the CLI flags | `groundingText` in `lib/grounding.agency`, which calls `parseAgentArgs()` |
| The user's global `AGENTS.md` | A `static const` in `lib/globalInstructions.agency` |
| MCP tools, learned tools, Claude Code skills | `lib/mcp.agency`, `lib/learned.agency`, `lib/claudeSkills.agency` |
| Whether a person is at the terminal | `setCodeOneShot`, `setUserCanAnswer`, `isInteractive()` |
| Whether to print a line when a subagent starts | `announce`, which reads `isTraceEnabled()` in `lib/trace.agency` |

The brains also do three things a library function must not do:

1. `coordinatorInit` prints and calls `_exit(1)` when a bundled prompt is missing.
2. Each brain wraps its turn in a named session, such as `thread(label: "main", session: "main")`. Every call in a program would then share one hidden conversation.
3. The router prints a notice when the router model fails.

## Goals

- `agencyAgent` is an exported function in `stdlib/agents/agency.agency`. A user can call it from code or pass it as a tool.
- All three brains are in the stdlib. A `brain` parameter picks one.
- The function reads no file from the user's home folder or project. Importing the module reads only files packaged with Agency.
- The function installs no policy handler. The caller's handlers decide every interrupt.
- `agency agent` becomes a caller of this function. A user at the REPL sees the same behaviour as today, except for the `question` tool, which is removed.

## Not goals

- No change to the REPL, slash commands, saved sessions, settings, presets, or approval prompts, beyond what removing sessions requires.
- No new effect and no `readAgentFiles` parameter. See "Per-user files".
- No compaction inside the function.
- No change to `question` in `std::agent`. The function stays for programs that call it directly.
- No parameter, setting or branch in the stdlib that exists for a run with nobody present. See "No one-shot mode".
- No change to how the brains use memory. Memory is off in `agency agent`, so none of the following has an effect there. A library user who has memory on gets all of it, which is a known problem left for later:
  - The coordinator calls `setMemoryId("main")` and passes `memory: true` to its own `llm()` call.
  - The research wrapper calls `setMemoryId("research")` and offers `memoryTools()`.
  - The review, writing and rewrite wrappers each call `setMemoryId` with their own name.

## Design

The work has three parts. Each part can be its own pull request, in this order.

### Part 1: remove the `question` tool from the agents

Ten stdlib agents offer `question` through `communicationTools()` and describe it through `askUserHint()`: coding, github, explorer, planner, researcher, review, data, verifier, typescript/review and writing/review. The coordinator offers it in its own tool list, and passes it as an extra tool to the oracle, the Agency researcher and the Agency reviewer.

All of these stop offering it. `communicationTools`, `askUserHint` and `ASK_USER_HINT` are deleted from `stdlib/agents/lib/toolkits.agency`.

`setUserCanAnswer` and `userCanAnswer` are deleted too. Their one remaining reader is `designTool` in `stdlib/toolbox.agency`, whose author has its own asking tool. `designTool` then always offers that tool, which is what it does today in every program that never calls the setter. Its `NO_ASK_RULE` text and the two branches that read `userCanAnswer()` are deleted. In `agency agent -p`, a question from that author is rejected by the policy handler with a message the model reads, as `docs/dev/stdlib/asking-the-user.md` describes.

Two bundled prompts mention asking the user: the coordinator's `main.md` and `agency-code.md`. Any line that names the `question` tool is removed. `stdlib/agents/skills/data/finding-identifiers.md` uses the word "question" too, and needs a read to see whether it names the tool.

### Part 2: remove thread sessions from the agent

The session names are left over from an earlier design that kept several conversations going at once. Each brain uses one session, and three subagent wrappers (review, writing, rewrite) use one each.

Without a `thread` block, a function's `llm()` calls land on the active thread of whoever called it (`docs/dev/runtime/threads.md`). That gives the behaviour we want for the stdlib function:

- Called from code, it continues the caller's thread.
- Called as a tool, it starts on a fresh thread, because the tool loop gives every ordinary tool one.

So `agencyAgent` is a plain `def`. It is not a `handoff def`, which is what `codingAgent` and most stdlib agents are. A handoff would continue the caller's conversation when called as a tool, and that is not what we want here.

#### What the CLI loses and how it gets it back

Five CLI features find the conversation by its session name, through `AgentBrain.session`:

| Feature | Where |
|---|---|
| `/compact` and automatic compaction | `lib/repl.agency`, `lib/compaction.agency`, `lib/stdlib/agentCompaction.ts` |
| The context percentage in the status line | `contextStatus` in `lib/compaction.agency` |
| The session title | `conversationText` in `lib/sessionTitle.agency` |
| The `searchSessions` tool | `lib/sessionSearch.agency` |
| The transcript printed on resume | `_readTranscript` in `lib/stdlib/agentSessions.ts` |

After this part they find it by thread id instead. The harness records the id once a turn has run:

```
// lib/turn.agency, in the harness runTurn, after the brain returns
setConversationThread(currentThreadId())
```

`currentThreadId` already exists in `std::thread`. The TypeScript helpers take that id where they take a session name today. The id is also written into the saved session's record, because the resume transcript is read from the checkpoint file before the run is restored.

The system prompt changes with this. Each brain has a `first` flag that adds the system prompt on the first turn. That flag is replaced by `ensureSystemMessage`, which adds a system message only when the thread does not already hold it.

The three subagent wrappers keep a `thread` block with a label and `summarize: true`, and lose the `session:` argument. They start a fresh thread on every call.

`--agent code` and `--agent agencyCode` run the coder on a session today so that a later turn sees the earlier ones. Without the session they run on the REPL's own conversation thread, which gives the same result.

#### The assumption this depends on

The REPL calls each turn through a TypeScript hook (`_sessionOnSubmit` in `lib/stdlib/agentSessions.ts`). This design assumes that two turns called that way share one thread store, and that the default thread stays active between them. `ThreadStore.getOrCreateActive` leaves the thread it creates on the active stack, which supports the assumption. It has not been run. The first task of the plan is a test that proves it. If the test fails, the fallback is for the harness to wrap every turn in one `thread(session: "conversation")` block of its own. The stdlib function would still have no session.

#### Saved sessions from before the change

A checkpoint is refused when the code of a module it is paused inside has changed (`docs/dev/runtime/checkpoint-code-fingerprints.md`). A saved REPL session is paused inside `agent.agency`, `lib/repl.agency` and `lib/turn.agency`, and this work changes all three. So sessions saved before the change cannot be resumed after it, as with any other change to those files. No migration is written.

### Part 3: the stdlib function

#### The signature

```
export type AgencyAgentBrain = "coordinator" | "minimal" | "simple"

export type AgentExtraTools = {
  main?: any[];
  coder?: any[]
}

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

Each parameter, and what an empty value means:

- **`task`**: the user's message.
- **`context`**: extra text for the model, such as project instructions. It is added as a system message that is removed when the call ends. Each subagent wrapper also passes it to its stdlib agent, in the place where the wrapper passes the global instructions today.
- **`brain`**: which brain answers.
- **`maxCost`, `maxTime`**: the budget for the whole call. A negative value means no limit. See "Budgets" below. When a budget runs out, the caller gets a failure, or the saved draft if there is one, as with `codingAgent`.
- **`model`, `provider`**: the main model. The coder, the researcher and the reviewers run on it. Empty means the ambient model, which is the one `setModel` or `setLlmOptions` chose.
- **`reasoningModel`, `reasoningProvider`**: the coordinator's own calls, the oracle and the explorer run on it. Empty means the main model.
- **`routerModel`, `routerProvider`**: the small model that sends a plain message straight to the coder or the researcher. Empty means no routing.
- **`extraTools`**: extra tools, as a record with one optional list per agent. See "Extra tools" below.
- **`attachments`**: images or files sent with the message.

The `minimal` and `simple` brains use `model` and `provider` only. They ignore the reasoning and router models.

#### Extra tools

```
agencyAgent(task, extraTools: { main: [lookupOrder], coder: jobTools() })
```

`extraTools` is a record, and each key names who gets the list:

- **`main`**: added to the tools of the model that answers the turn. For the coordinator brain that is the coordinator. For the `minimal` and `simple` brains it is the brain's one model. The `simple` brain has no tools of its own, so it offers only these.
- **`coder`**: added to the tools of the coder and the Agency coder. Only the coordinator brain has those, so the other two brains ignore this key.

A missing key means no extra tools for that agent. The two lists are separate on purpose. A caller's main list can be long, and a tool in the coder's list is paid for on every coder request.

This shape differs from `codingAgent` and the other stdlib agents, where `extraTools` is a plain list. Those agents have one model to give tools to, and this one has several. Another subagent can get a key later without a new parameter.

#### No one-shot mode

The function has one mode. It has no parameter and no setting that says whether a person is present. Today's brains read that fact in four places, and each is removed from the function:

| What reads it today | What happens instead |
|---|---|
| `setUserCanAnswer`, for the `question` tool | The tool is gone (Part 1), and so is the setter |
| `setCodeOneShot`, for the coder's reply-style text | The coder always gets the text |
| `setCodeOneShot`, for the background job tools | The function does not offer job tools. A caller passes them in `extraTools` |
| `messageWasRewritten()`, to skip the router | The function always routes when it has a router model. A caller that does not want a message routed passes no router model for that call |

The job tools are left out for a second reason. A background job belongs to the run and is stopped when the run ends (`docs/dev/stdlib/jobs.md`). In a web server, a run usually ends when the call returns, so a job the agent started would be stopped before it finished. A caller whose run stays alive, such as the REPL, passes the job tools in.

`agency agent` keeps its own one-shot logic, in the CLI. In `-p` mode it passes no job tools, as today. The one change a `-p` user gets is that the coder receives the one-sentence reply-style text.

#### Budgets

`maxCost` and `maxTime` are typed `number`, as they are on `codingAgent` and every other guarded stdlib agent. `guard` already treats a negative limit as "no limit for this dimension" (`pushGuardImpl` in `lib/stdlib/thread.ts`), so a caller who wants no budget passes a negative number for each:

```
agencyAgent(task, maxCost: -1, maxTime: -1)
```

The CLI does this. Its `--max-cost` and `--max-time` flags use the same convention.

`null` is not accepted. `guard` throws a JavaScript error when both limits are `null`, and `@guarded` would pass that on.

#### What is not a parameter

- **Reasoning effort and tool-loop limits.** The CLI sets these with `setLlmOptions`, and the function inherits them. A library user can do the same.
- **The working directory.** `setAgentCwd` in `std::index` already sets it for every stdlib tool.
- **A policy.** The caller wraps the call in a handler, or uses `std::policy`.

#### Per-user files

The function reads none of the user's files. The CLI reads them, as it does today, and passes the results in.

A `static const` is initialized once per process and shared by every run (`docs/site/guide/global-vs-static.md`). The CLI's scans are statics for that reason, and they stay statics, in the CLI's own modules:

```
// lib/agents/agency-agent/lib/claudeSkills.agency, unchanged
static const SKILL_SOURCES = loadSkillSources(cwd(), os.homedir())
```

The CLI then passes the values on every turn:

```
agencyAgent(
  task: message,
  context: globalInstructionsText(),
  extraTools: { main: cliTools(), coder: sessionJobTools() },
  ...
)
```

A user who runs the agent in a web server and wants the same files writes a static in their own module and passes it the same way. The files are then read once per process, and the read is visible in their code.

The statics could not move into the stdlib module. A static runs when its module loads, so every program that imports `std::agents/agency` would scan the user's home folder, whether or not it wanted those files. A handler in the program's own code could not refuse the read, because the static runs before that code does. A root policy, such as `--policy` or `--reject`, is installed before module initializers and could still refuse it.

#### What moves to the stdlib

| From `lib/agents/agency-agent/` | To `stdlib/agents/` |
|---|---|
| `brains/simple/simple.agency` | `brains/simple.agency` |
| `brains/minimal/minimal.agency` | `brains/minimal.agency` |
| `brains/coordinator/coordinator.agency` | `brains/coordinator.agency` |
| `brains/coordinator/router.agency` | `brains/coordinator/router.agency` |
| `brains/coordinator/subagents/*.agency` | `brains/coordinator/*.agency` |
| `brains/coordinator/lib/budgets.agency` | `brains/coordinator/budgets.agency` |
| `brains/coordinator/prompts/main.md` | `prompts/coordinator.md` |
| `brains/coordinator/prompts/agency-code.md` | `prompts/agency-code.md` |
| `lib/images.agency` | `brains/coordinator/images.agency` |
| `brains/coordinator/lib/announce.agency` | Deleted. See "Progress and printing" |

`lib/jobsNote.agency` stays in the CLI. The CLI adds the jobs note to the thread before it calls the function, as it adds the grounding.

Two things in `subagents/code.agency` change as it moves. It reads `agency-code.md` through its own `promptFile` function, which builds the path from `AGENT_SOURCE_DIR` in `lib/agentSource.agency`, a CLI module. In the stdlib it reads the file with `agentPrompt("agency-code.md")`, and `promptFile` is deleted. `tests/agency/agency-agent-code-prompt.agency` calls `promptFile` to check that both prompts load, so that test changes to check the two statics instead. The `agencyCli` tool moves with the file.

`stdlib/agents/agency.agency` holds `agencyAgent` and the list of brains. `stdlib/agents/agency/` already exists and holds the agents that write Agency code. A file and a folder with the same name already sit side by side at `stdlib/agency.agency` and `stdlib/agency/`.

#### How settings reach the subagent wrappers

The wrappers (`codeAgent`, `oracleAgent` and the rest) are tools the coordinator's model calls. Today they read module-level variables. In the stdlib they take their settings as extra parameters, and the coordinator binds those with `.partial` before it builds the tool list. The coordinator already does this for one tool:

```
elapsedTime.partial(since: turnStart)
```

The oracle wrapper becomes:

```
export handoff def oracleAgent(
  settings: AgentSettings,
  userMsg: string,
  maxSeconds: number | null = null,
  maxDollars: number | null = null,
): Result<string> { ... }

// in the coordinator
oracleAgent.partial(settings: settings)
```

`AgentSettings` is one record built by `agencyAgent` from its parameters. Its `coderTools` field is the `coder` list from `extraTools`:

```
export type AgentSettings = {
  context: string;
  model: string;
  provider: string;
  reasoningModel: string;
  reasoningProvider: string;
  routerModel: string;
  routerProvider: string;
  coderTools: any[]
}
```

`settings` comes first because Agency refuses a parameter with no default after one that has a default. `.partial` binds by name, so the position does not matter to the coordinator. A bound parameter does not appear in the tool's schema, so the model sees the same three parameters it sees today.

#### The coordinator's prompt

`prompts/main.md` names things only the CLI has. Lines 21 to 25 describe `learnSkill` and `writeToolFor`. Line 68 points at the `<session_facts>` block. Neither belongs in the stdlib prompt:

- The text about `learnSkill` and `writeToolFor` moves into the docstrings of those two tools. Only the CLI offers them, so the text then reaches exactly the model that can call them.
- The sentence about `<session_facts>` moves into the grounding block itself, in `sessionFactsText` in `lib/grounding.agency`.

The rest of the file moves to the stdlib unchanged.

#### Progress and printing

The function prints nothing and does not exit. A missing bundled prompt returns a failure.

A caller follows the agent's progress through the runtime's callbacks, which every Agency program already has (`docs/site/guide/callbacks.md`). The same callbacks work for a terminal and for the back end of a web app, because the caller decides what to do with each event. `agency agent` prints all of its tool lines this way today, from the callbacks in `lib/trace.agency`:

| Callback | What it reports |
|---|---|
| `onToolCallStart`, `onToolCallEnd` | Each tool call, its arguments, its result and its duration |
| `onLLMCallEnd` | Each model reply, including the progress sentence a model writes beside its tool calls |
| `onLLMRetry` | A retried model call |
| `onEmit` | Anything a program passes to `emit` from `std::statelog` |

Two things the CLI prints today do not come from those callbacks: the line when a subagent starts, and the notice when the router model fails. The function reports both with `emit`:

```
emit({ type: "agencyAgent.subagentStart", agent: "codeAgent", message: userMsg })
emit({ type: "agencyAgent.routerFailed", model: model, provider: provider, error: error })
```

The CLI prints them from an `onEmit` callback in `lib/trace.agency`. A web app receives the same events from its own `onEmit`. The function takes no callback parameter, because `emit` already does this job.

#### What stays in the CLI

- `agent.agency`, `lib/args.agency`, `lib/repl.agency`, and everything about sessions, settings, presets, models and policy.
- The static scans: Claude Code skills, `.claude/commands`, the global `AGENTS.md`, and the bundled `presets` skill.
- MCP loading.
- The tools that only make sense with the CLI's files: `learnSkill`, `writeToolFor`, `learnTools`, `listPresets`, `savePreset`, `deletePreset`, `setDefaultPreset`, `useLlmOptions`, `searchSessions`.
- Attachment detection, slash expansion, pending notes, and the budget clue.
- The `--agent` start targets.

#### The CLI as a caller

The `brains/` folder under `lib/agents/agency-agent/` goes away, and so do the `AgentBrain` record and the registry. One new module, `lib/agents/agency-agent/lib/answer.agency`, builds the call:

```
export def answerTurn(message: string, attachments: Attachment[]): string {
  const result = agencyAgent(
    task: message,
    context: globalInstructionsText(),
    brain: currentBrainName(),
    maxCost: -1,
    maxTime: -1,
    reasoningModel: getSlowModel(),
    reasoningProvider: getSlowProvider(),
    routerModel: routerModelFor(message),
    routerProvider: getRouterProvider(),
    extraTools: { main: cliTools(), coder: sessionJobTools() },
    attachments: attachments,
  )
  return replyText(result)
}
```

`routerModelFor` returns `""` when the CLI rewrote the message, for example by expanding a slash command, and the router model otherwise. `sessionJobTools()` returns the job tools in the REPL and `[]` in `-p` mode. Both are CLI functions, so the one-shot logic stays in the CLI.

The CLI passes no main model, because `pickModelsForAgent` already sets the ambient one. It passes no budget, because a whole-agent limit comes from `--max-cost` and `--max-time`, which the runtime enforces.

`cliTools()` joins MCP tools, learned tools, Claude skills, generated tools, the CLI-only tools listed above, and in the REPL the job tools with the readers for saved output.

#### What the CLI puts on the thread itself

The CLI has two kinds of extra text for the model, and they travel differently.

**The global instructions** go in `context`. Today every brain adds them as a system message that expires with the `llm()` call, and every wrapper passes them to its subagent. `context` does both of those things, so nothing changes.

**The grounding block** does not go in `context`. It holds the session facts, the date, the working directory and the project `AGENTS.md`. Today it is part of the coordinator's first system message, which stays on the thread for the whole session. Two things follow from that, and both are worth keeping:

- The provider caches it. A message that expires with each call is sent again, uncached, on every turn, and a project `AGENTS.md` can be large.
- The subagents on a fresh thread (review, writing, rewrite) do not receive it. They receive only the global instructions.

So the CLI adds the grounding to the conversation thread itself, before it calls the function.

The grounding is built once per run, as it is today. `runSession` builds it before it installs the policy handler and stores the string:

```
// lib/turn.agency, in runSession, where buildBrainContext is called today
setGrounding(groundingText(brainName))
```

Each turn then adds that stored string:

```
// lib/answer.agency
ensureSystemMessage(grounding())
const result = agencyAgent(task: message, context: globalInstructionsText(), ...)
```

The stored string matters. `ensureSystemMessage` skips a message only when the thread already holds one with the same text. `groundingText` rereads every `AGENTS.md` file and includes the date, the working directory and the resolved models. If the CLI rebuilt it on every turn, any change to one of those would add a second grounding block beside the first. With the stored string, a conversation has one grounding message, with the same contents as today. After a resume the variable comes back from the checkpoint with the old text, so it still matches the message on the thread.

The `--agent code` start target does the same with the project block. It builds the block once and passes the stored string to `ensureSystemMessage`.

The function is called from code here, so it continues that thread and the model sees the grounding. `withProjectContextIfMoved` keeps handling a changed working directory, as it does today.

The grounding and the coordinator's prompt are then two system messages, where today they are one.

`runSession` still installs the policy handler around every turn, and `guardStopHandler` still answers a subagent's budget trip. Neither changes.

`learnTools` is a handoff that finishes the user's request with the full tool list. It needs the coordinator's own tools as well as the CLI's. So the stdlib coordinator exports the function that builds them:

```
export def coordinatorTools(settings: AgentSettings, turnStart: any): any[]
```

#### Start targets

`--agent code`, `--agent oracle` and the others call one subagent directly. They stay in the CLI, in `lib/agents/agency-agent/lib/startTargets.agency`, and call the stdlib wrappers. `--brain` help and the list of valid `--agent` values come from that module and from the stdlib's list of brains.

## Handlers and interrupts

This section answers the questions a reviewer of this area asks.

- **Is any handler skipped?** No. The CLI calls `agencyAgent` inside `runSession`, in the same position where it calls `brain.runTurn` today. The policy handler is still the outermost handler.
- **Does the function approve anything itself?** Only the reads of files packaged with Agency, through `agentPrompt` and `agentSkill`, which is what the stdlib agents already do. The `with approve` on the user's own files stays in the CLI.
- **Does `@guarded` change who answers a budget trip?** `@guarded` rejects its own trip, matched by label. A subagent's trip is answered by the subagent's own `@guarded`. `guardStopHandler` in the CLI is unchanged and answers any that reach it.
- **Does anything new go into a checkpoint?** One string, the conversation thread id, as an Agency global in the CLI and as a field on the saved session record.

## Owner decisions

None are open. The owner chose `main` for the first key of `extraTools`. It fits the `minimal` and `simple` brains, which have no coordinator.

One point needs no decision but should be known. A model that calls `agencyAgent` as a tool sees `maxCost` and `maxTime` in the schema and can pass a negative number, which removes the default budget for that call. The same is true of `codingAgent` today. The caller's own guards still apply.
