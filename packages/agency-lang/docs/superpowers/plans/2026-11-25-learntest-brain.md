# The learntest Brain: Implementation Plan

**Goal:** Add a trial brain named `learntest` to the Agency agent. It is the minimal brain plus one tool, `learn`, and a few lines in the system message that say where learnable tools are on disk. Then measure whether an agent that starts with five tools and learns the rest does as well as an agent that is given every tool up front.

**The question behind it:** Every tool an agent is given is sent to the model with every request. A large tool list costs money on every call and crowds the context. A small tool list is cheap but limits what the agent can do. If a model reliably finds and learns the tool it needs, we can build agents that start small and still reach a large library. This plan builds the smallest thing that can answer that question.

**Two phases, two pull requests.**

- Phase 1 is one PR to agency-lang: the brain, the `learn` tool, the index file, the tests, and the dev doc.
- Phase 2 is one PR to the private `~/agency-evals` repo: a suite of tasks that need a stdlib function, run three ways. Phase 2 gets its own plan after phase 1 merges. This document outlines it so the phase 1 design can be judged against what it has to measure.

**Paths.** Every path in this document is relative to `packages/agency-lang/` unless it starts with `~`.

**Reviews applied:** `docs/superpowers/plans/2026-11-25-learntest-brain.architecture-review.md` and `docs/superpowers/plans/2026-11-25-learntest-brain-review.md`.

---

## Background: how learning works today

This part describes the code as it is on `main`. Nothing here is a proposal.

### The library function

`learn` in `stdlib/agency.agency` turns exported functions of an Agency module into tools a model can call.

```agency
import { learn } from "std::agency"

node main() {
  const learned = learn(
    { kind: "module", module: "std::data/finance/fred" },
    names: ["fredSeriesInfo"],
  )
  if (learned is failure) {
    return learned
  }
  return llm("Describe the UNRATE series.", tools: learned.value)
}
```

The first argument says where the code is. It has three forms:

- `{ kind: "module", module: "std::data/finance/fred" }` names an installed stdlib module.
- `{ kind: "file", dir: "/some/folder", filename: "tools.agency" }` names a file. The file's local imports must stay inside `dir`.
- `{ kind: "source", source: "..." }` carries the program text itself.

`names` selects functions. An empty list selects every public function in the module.

`learn` compiles the module and runs its top-level code once in a separate process to read each function's parameters and description. It does not call the functions. Each later call of a learned tool starts a new process, which takes about 0.4 seconds for a small module.

`learn` returns the tools and does nothing else. It does not add them to any agent. The caller decides what to do with them.

### The interrupts a learned tool raises

Starting a process raises the `std::run` effect. That happens once when `learn` inspects the module and once for each later call. For a stdlib module or a file, the interrupt's data carries `module` and `function`, so a policy rule can approve one module by name.

The function's own effects are raised from inside the child process and reach the parent's handlers. A learned `fredSeriesInfo` raises `std::run` to start, and then the same network effect it would raise if the program had called it directly. A learned tool is therefore under the same policy as every other tool.

### How the coordinator keeps learned tools

The command-line agent offers the coordinator brain a tool named `learnTools` (`lib/agents/agency-agent/lib/cliTools.agency:102`). Three pieces make it work.

**The state.** `lib/agents/agency-agent/lib/learn.agency` holds one Agency global:

```agency
let learnedState: LearnedState = { programs: [], records: [] }
```

`programs` holds the compiled code of each learning batch. `records` holds one plain record per learned tool: its name, its definition, and which program it belongs to. These records contain no functions, so they survive a checkpoint and a saved session. Two functions in that file use the state:

- `learnSessionTools(source, names, namespace, offeredNames)` calls `learn`, checks that no new name collides with an existing tool, and adds the records to the state.
- `getGeneratedTools()` rebuilds callable tools from the records. The agent calls it each time it assembles its tool list.

The TypeScript helpers both functions use are in `lib/stdlib/sessionTools.ts`, which is already part of the stdlib.

**The handoff.** `learnTools` is a `handoff def`. An ordinary tool runs on an empty conversation thread and returns a result. A handoff continues the caller's conversation instead (`docs/dev/language/handoff-functions.md`). `learnTools` learns the functions, builds a new tool list that includes them, and makes its own `llm` call with that list on the same thread. The model sees the user's original request and the new tools together, and it can call a learned tool in the same turn. Then `endTurn()` ends the caller's loop and the handoff's answer becomes the turn's answer.

A handoff is needed because the tool list of an `llm` call is fixed when the call starts. A tool learned in the middle of a call cannot be added to that call. The handoff starts a second call that has the new list.

**The next turn.** On the next user message, the agent assembles its tools again, `getGeneratedTools()` rebuilds the learned tools from the records, and they are offered as before.

### What is missing

`learnTools` exists only in the command-line agent's own folder, and it is written for the coordinator: it rebuilds the coordinator's tool list by name. No stdlib brain can use it.

Nothing tells a model what there is to learn. The coordinator's prompt (`stdlib/agents/prompts/coordinator.md`) does not mention `learnTools` or any stdlib module.

The stdlib's source files ship in the npm package (`package.json:55`), so they are on the user's disk. No Agency function returns the folder they are in. The TypeScript helper `stdlibDir()` in `lib/stdlib/skills.ts:7` does, and it is not exported.

### The brains

`agencyAgent` in `stdlib/agents/agency.agency` answers one message with one of five brains (`docs/dev/agents/agent-brains.md`). The minimal brain (`stdlib/agents/brains/minimal.agency`) is one `llm` call with four tools: read, bash, edit, and write. Its system message is the seven-line `CODING_RULES`.

Two trial brains are built on it. `scripttest` and `spawntest` each call `minimalBrain` with extra tools and add a short text to the system message. A trial brain differs from minimal in a known, small way, so a benchmark run of the two measures that one difference. `learntest` follows the same pattern.

---

## The design

### What a run looks like

```
User:   What are the top stories on Hacker News right now?

Model:  read <stdlib>/agents/prompts/learnable-tools.md
        → ...
          data/tech/hackernews.agency: Hacker News stories, comments, and search
          ...
Model:  bash: grep -n "export def" <stdlib>/data/tech/hackernews.agency
        → export def hnTopStories(limit: number = 30) ...
Model:  learn(file: "data/tech/hackernews.agency", names: ["hnTopStories"])
        → the turn continues with hnTopStories in the tool list
Model:  hnTopStories(limit: 5)
Model:  The top stories are ...
```

The function name in this example is illustrative. The model finds the real name with grep.

### Decision 1: move the learning state into the stdlib

`learnedState`, `getGeneratedTools`, and `learnSessionTools` move, unchanged, from `lib/agents/agency-agent/lib/learn.agency` to a new stdlib module, `stdlib/agents/lib/learning.agency`, imported as `std::agents/lib/learning`.

The command-line agent imports the two functions from the new module. `learnTools` and the coordinator behave exactly as before. `learnSkill` and `writeToolFor` stay where they are, because they save to the agent's home folder, which only the command-line agent has.

One run uses one brain, so the coordinator's `learnTools` and the new brain's `learn` never write to the state in the same run.

Perry can import `std::agents/lib/learning` and write its own learn tool in a few lines once this is released. That change belongs to Perry and is not part of this plan.

### Decision 2: `learn` takes a path and a list of names

```
learn(file: string, names: string[])
```

The coordinator's `learnTools` takes the three-form `source` record. A model has to build a nested object and has to know that `stdlib/data/finance/fred.agency` is the module `std::data/finance/fred`. Both are places to make a mistake. The new tool takes the path that grep printed, and code does the translation.

The translation is one TypeScript function, `_learnSource(file, cwd)`, in a new file `lib/stdlib/learnSource.ts`. It is built from helpers that exist: `isContained` in `lib/stdlib/isContained.ts` decides whether a path is inside the stdlib folder, `stdlibModuleName` in `lib/importPaths.ts` turns a stdlib path into its `std::` name, and the result is a value of the `AgencySourceValue` type in `lib/stdlib/agencyFunctions.ts`. Its rules:

1. The path must end in `.agency`. Anything else is a failure that says so.
2. A path that starts with `~/` is expanded to the user's home folder. An absolute path is then used as written.
3. A relative path is looked up in the agent's working directory. If no file is there, it is looked up in the stdlib folder. If neither exists, the failure names both places it looked.
4. A file inside the stdlib folder becomes a module source. `<stdlib>/data/finance/fred.agency` becomes `{ kind: "module", module: "std::data/finance/fred" }`.
5. Any other file becomes a file source. `/Users/me/tools/chrome.agency` becomes `{ kind: "file", dir: "/Users/me/tools", filename: "chrome.agency" }`.

Rule 1 does two jobs. It gives the model a clear error for a wrong file. It also limits what the parent process reads before anyone has approved anything: `learn` reads and parses the file before it raises its first `std::run`, and that read raises no interrupt of its own. The coordinator's `learnTools` has the same property today. With rule 1, the only files the tool will open this way are Agency source files.

Rule 2 is there because models often write `~` paths, and the Perry example below is one.

Rule 4 matters for approvals. A module source puts `module: "std::data/finance/fred"` in the `std::run` interrupt, so the approval prompt names the module and a policy rule can match it. It also gives the existing "wrong module" error messages, which tell the model which module exports a name it asked for. A module source also loads differently: installed stdlib code is trusted and skips the validator that a file source goes through (`lib/stdlib/agencyFunctions.ts:93`). A module source never loads the path the model wrote. The loader rebuilds the path from the module name and refuses a name that points outside the stdlib folder (`lib/stdlib/agencyFunctions.ts:68`).

Rule 3 lets the index file list short paths such as `data/tech/hackernews.agency`. The model can pass that text straight to `learn`.

Rule 5 is what makes the tool useful beyond the stdlib. A folder of your own Agency files needs no setup. This is the path a Perry demo would take: "learn the Chrome tools from `~/demo-tools/chrome.agency`".

An empty `names` list is refused with a message that asks for the function names. The library's `learn` treats an empty list as "every public function", which would add a whole module's tools to the context in one call.

Learned tools keep their own names. The coordinator's `learnTools` prefixes each name with `session_`. The new tool passes an empty namespace, so `hnTopStories` is offered as `hnTopStories`. A name that is already in the model's tools is refused. Two index candidates export the same name: `wikipedia` and `web/search` both export `search`. A model that has learned one cannot learn the other in the same conversation.

The existing check in `_addLearnedRecords` would catch this, but its message ends "Choose another namespace", and this tool has no namespace to choose. So the handoff checks the names itself first, with a message the model can act on:

```
A tool named 'search' is already in your tools, so this function cannot be learned in this conversation.
```

The check in `_addLearnedRecords` still runs after it and should never fire. Letting the model learn both, for example by prefixing a learned name with its file name, is a possible follow-up if the experiment shows the limit matters.

### Decision 3: `learn` is a handoff, like the coordinator's

The reason is the one given in the background: the running `llm` call cannot gain a tool. The handoff learns, then makes a new `llm` call on the same thread with the longer tool list, then calls `endTurn()`.

The new tool list contains `learn` itself, so the model can learn again later in the same turn. That second learn is a handoff inside a handoff, which the runtime already supports and the coordinator already relies on.

The continuation needs the same model options the minimal brain uses. Today `minimalBrain` builds them inline. This plan moves those five lines into an exported function, `minimalOptions(settings, extraTools)`, in `stdlib/agents/brains/minimal.agency`, and both `minimalBrain` and the handoff call it. `minimalBrain` behaves as before.

### Decision 4: the brain

The whole brain, in `stdlib/agents/brains/learntest.agency`. This code parses; `_learnSource` and `_stdlibDir` are the two new TypeScript helpers.

```agency
import { _learnSource } from "agency-lang/stdlib-lib/learnSource.js"
import { _agentPromptsDir, _stdlibDir } from "agency-lang/stdlib-lib/skills.js"
import { minimalBrain, minimalOptions } from "std::agents/brains/minimal"
import { AgentSettings } from "std::agents/brains/settings"
import { getGeneratedTools, learnSessionTools } from "std::agents/lib/learning"
import { getAgentCwd } from "std::index"
import { Attachment, endTurn, ensureSystemMessage } from "std::thread"

def learnPrimer(): string {
  const stdlib = _stdlibDir()
  const index = "${_agentPromptsDir()}/learnable-tools.md"
  return """
You can gain tools. The Agency files under ${stdlib} hold tools for data sources, the web, images, OCR, speech, GitHub, calendar, and weather. ${index} lists them, one per line, and you can grep the folder for anything else. When a task needs one, call learn with the file's path and the names of the functions you want. The tools stay for the rest of the conversation.
"""
}

def learntestExtras(settings: AgentSettings, extraTools: any[]): any[] {
  return [
    learnFromFile.partial(settings: settings, extraTools: extraTools).rename("learn"),
    ...extraTools,
    ...getGeneratedTools(),
  ]
}

handoff def learnFromFile(
  settings: AgentSettings,
  extraTools: any[],
  file: string,
  names: string[],
): Result<string> {
  """
  Gain tools from an Agency file, then continue the user's request with them.

  @param file - The path of the Agency file, as grep printed it
  @param names - The exported functions to learn
  """
  if (names.length == 0) {
    return failure("Name the functions to learn.")
  }
  const before = minimalOptions(settings, learntestExtras(settings, extraTools)).tools
  const offered = [tool.name for tool in before]
  for (name in names) {
    if (offered.includes(name)) {
      return failure("A tool named '${name}' is already in your tools, so this function cannot be learned in this conversation.")
    }
  }
  const source = _learnSource(file, getAgentCwd())?
  const learned = learnSessionTools(source, names, "", offered)?
  const answer: string = llm(
    "The tools ${learned.join(", ")} are now available. Continue the user's request with them.",
    minimalOptions(settings, learntestExtras(settings, extraTools)),
  )
  endTurn()
  return success(answer)
}

export def learntestBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string> {
  ensureSystemMessage(learnPrimer())
  return minimalBrain(prompt, settings, learntestExtras(settings, extraTools))
}
```

Points about this code that a reviewer should check:

- **The function is `learnFromFile`, and the model sees it as `learn`.** `std::agency` already exports a function named `learn` with a different signature, so the def gets its own name and `.rename("learn")` sets the name the model sees. The minimal brain offers `readCapped` as `read` the same way. No handoff is renamed anywhere else in the codebase today, so test 6 in task 4 is the check that a renamed handoff still continues the caller's conversation. If it does not, stop and tell the owner, because that is a runtime bug.
- **The collision check reads the names from `minimalOptions(...).tools`.** That is the list the model is offered, so the two cannot differ.
- **`settings` and `extraTools` are bound with `.partial`.** A bound parameter is left out of the tool's schema, so the model sees only `file` and `names`. The coordinator binds `settings` on its subagent wrappers the same way.
- **Learned tools go last in the list.** The order is the four coding tools, `learn`, the caller's tools, then the learned tools. Tools that were there before a learn keep their position.
- **The primer is built in a function.** It contains the install path, and a top-level variable in a brain module may only call `agentPrompt` or `agentSkill` (`lib/stdlib/agentBrainStatics.test.ts`). `ensureSystemMessage` matches by exact text, and the path is the same for the whole run, so the thread holds the primer once.
- **The docstring is the tool description the model reads.** The final wording is written in task 4 and should say that grep finds function names and that a learn can fail without harm.

The primer is four sentences. That is the "categories plus a path" version from the brainstorm: enough for the model to know what kinds of thing exist, with the full list read on demand.

### Decision 5: the index file

`stdlib/agents/prompts/learnable-tools.md` lists the modules worth learning, one per line:

```
data/finance/fred.agency: US economic data series from FRED. Needs FRED_API_KEY.
data/tech/hackernews.agency: Hacker News stories, comments, and search.
```

The file goes in `stdlib/agents/prompts/` because that folder already ships in the npm package (`package.json:59`), so `package.json` does not change. Every other file in that folder is a system prompt, so the index starts with one sentence that says what it is and that the `learntest` brain's model reads it.

The index is curated by hand. A module belongs in it when a model could use its functions as tools: each call stands alone, and `learn` accepts at least one of its functions. The candidates to check in task 5:

- `data/finance/fred`, `data/finance/edgar`, `data/finance/dbnomics`
- `data/news/gdelt`, `data/people/littlesis`, `data/social/bluesky`
- `data/tech/hackernews`, `data/tech/yc`, `data/usaspending`, `data/wikidata`
- `wikipedia`, `weather`, `web/search`, `web/browser`
- `ocr`, `image`, `vision`, `speech`
- `github`, `calendar`, `clipboard`
- `messaging/email`, `messaging/imessage`, `messaging/sms`, `aws/s3`

Modules that keep state between calls or exist for program authors stay out: `thread`, `memory`, `jobs`, `policy`, `ui`, `args`, `agency`, and the agents. The model can still find them with grep, and `learn` will accept or refuse them by its ordinary rules. The index is a starting point and does not restrict anything.

A vitest test keeps the index true: every line names a file that exists, and the module has at least one public function in `lib/stdlib/stdlibModules.data.ts`. Renaming or deleting a listed module fails the test.

### Decision 6: the brain approves nothing

The brain installs no handler. Every interrupt goes to the caller's handlers, as for every other brain.

- Reading the index and grepping the stdlib folder go through the ordinary `read` and `bash` tools and raise their ordinary effects. In `agency agent`, the stdlib folder is outside the working directory, so the session's policy decides, or the user is asked. One "always approve when" answer for the folder covers the rest of the session.
- `learn` raises `std::run` once to inspect the module. Each call of a learned tool raises `std::run` again, then the function's own effects.
- In a one-shot run with no rule for these, the policy handler rejects them and the model reads the reason, as it does for any other tool.

A benchmark run needs a policy that approves reads under the stdlib folder and `std::run`. The suites that run in a container already approve everything.

### What happens at a checkpoint

Nothing new. Between turns, the learned records are in an Agency global, which a checkpoint and a saved session already keep. `tests/agency-js/learned-tools-resume` covers this for the same two functions, and task 1 only changes its import line. A checkpoint taken during an `llm` call keeps the active tool values through the existing function reviver (`docs/dev/stdlib/agency-function-tools.md`, "Checkpoints during a call").

### What is not in this plan

- **The prompt cache miss on each learn.** Tool definitions are the first thing in a model request, so adding a tool makes the provider read the whole conversation again at full price once. The brain accepts that cost, as `learnTools` does today. Phase 2 records cached tokens, which shows how large the cost is. If it is large, the follow-up is Anthropic's tool-addition block, which carries a new tool's definition in a message and leaves the front of the request unchanged. That is a change to smoltalk.
- **Dropping a learned tool.** A learned tool stays for the conversation.
- **Any change to the coordinator's behavior or prompt.**
- **Perry's learn tool.**
- **The command-line agent's handling of the new brain.** `agency agent --brain learntest` works with no harness change, because the flag is checked against `agencyAgentBrains()`. The harness gives CLI tools and the REPL style line only to the coordinator, so `learntest` is treated as minimal is.

---

## Phase 1: tasks

Work in the worktree `.worktrees/learntest-brain`. Run `pnpm install` there first. Save every test run's output to a file.

**The order of work.** The Agency tests import stdlib modules that exist only after `make`, so they cannot usefully be run before the build.

1. Write tasks 1 to 4, tests included. Task 2's vitest file needs no build, so write it first and see it fail before writing `learnSource.ts`.
2. Run `make` once. This is the plan's one build.
3. Run the tests for tasks 1, 3, and 4, and fix what fails.
4. Do task 4b when the owner gives the go-ahead. Tasks 5 and 6 do not wait for it.
5. Do tasks 5 and 6. Task 5 changes no `.agency` file, so it needs no second build.
6. Run task 7 once.

### Task 1: move the learning state into the stdlib

**Files:**
- Create: `stdlib/agents/lib/learning.agency`
- Modify: `lib/agents/agency-agent/lib/learn.agency`, `lib/agents/agency-agent/lib/cliTools.agency`
- Modify (import lines only): `lib/agents/agency-agent/tests/toolPresentations.agency`, `tests/agency-js/learned-tools-resume/agent.agency`, `tests/agency-js/coordinator-session-tools/agent.agency`

**Steps:**

1. Create `stdlib/agents/lib/learning.agency` with a `@module` doc comment, the `LearnedRecord` and `LearnedState` types, the `learnedState` global, `getGeneratedTools`, and `learnSessionTools`. The code is moved as it is. Both functions get a doc comment and a docstring, because the stdlib reference page is generated from them.
2. Delete those five things from `lib/agents/agency-agent/lib/learn.agency`. Its `std::agency` import and its `sessionTools.js` import go with them if nothing else in the file uses them.
3. In the three test files, change the import line to `import { getGeneratedTools, learnSessionTools } from "std::agents/lib/learning"`.
4. In `lib/agents/agency-agent/lib/cliTools.agency`, line 16 imports four names from `./learn.agency`. It becomes two imports: `learnSkill` and `writeToolFor` stay on the `./learn.agency` line, and the other two come from the new module.

**Check:** the three existing learning tests pass unchanged apart from their import lines. They are `tests/agency-js/coordinator-session-tools`, `tests/agency-js/learned-tools-resume`, and `tests/agency-js/learned-tool-parity`. They run in task 7.

### Task 2: the path translation

**Files:**
- Create: `lib/stdlib/learnSource.ts`, `lib/stdlib/learnSource.test.ts`
- Modify: `lib/stdlib/skills.ts`

**Interface:**

```ts
// lib/stdlib/skills.ts, next to _agentPromptsDir
/** The folder that holds the stdlib's Agency sources. */
export function _stdlibDir(): string;

// lib/stdlib/learnSource.ts
/** Turn a path into the source `learn` takes. See the rules in the plan. */
export function _learnSource(file: string, cwd: string): ResultValue;
```

`_stdlibDir` returns what the private `stdlibDir()` in that file returns. It is the only new name for the folder.

`_learnSource` returns `success(source)` or `failure(message)`, with the `success` and `failure` from `lib/runtime/result.ts` that `sessionTools.ts` already uses. The source is an `AgencySourceValue`. The function uses `isContained` for the "inside the stdlib folder" check and `stdlibModuleName` for the module name. It declares no type and writes neither check itself.

`stdlibModuleName` finds the stdlib folder through `getStdlibDir()`, and `_stdlibDir` finds it through the host. Both join `"stdlib"` to `getPackageRoot()`: see `lib/importPaths.ts:82`, and `installDir` in `lib/host/node/nodeHost.ts:244`. So they return the same folder. Test 11 in task 4 fails if a later change makes them differ.

The function reaches the disk only through helpers that exist:

- `expandPath(target, homeDir)` in `lib/stdlib/expandPath.ts` expands a leading `~`. The home folder comes from `currentHost().system.homeDir()`, as `expandTilde` in `lib/stdlib/prepareContainedPath.ts:43` gets it.
- `wholePath(...)` and `stat(root, target)` check whether a file exists, as `checkStdlibModule` in `lib/stdlib/agencyFunctions.ts:83` does. The function does not import `fs`.

The function body takes the stdlib folder as a parameter of an inner, unexported function, so the tests can point it at a fixture folder.

**Tests, written first** (`lib/stdlib/learnSource.test.ts`), each with a fixture folder made in a temporary directory and removed with `safeDeleteDirectoryWithin`:

1. An absolute path inside the stdlib folder gives `{ kind: "module", module: "std::wikipedia" }`.
2. A nested stdlib path gives `std::data/finance/fred`.
3. A relative path that exists in the working directory gives a file source with that directory and filename.
4. A relative path that exists only in the stdlib folder gives a module source.
5. A relative path that exists in both gives the working directory's file.
6. An absolute path outside the stdlib folder gives a file source whose `dir` is the file's folder.
7. A path that does not end in `.agency` fails, and the message says the file must be an Agency file.
8. A path that exists nowhere fails, and the message names both places.
9. A sibling folder whose name starts with the stdlib folder's name, such as `stdlib-extra/x.agency`, gives a file source. This fails if the function compares path strings instead of calling `isContained`.
10. `~/x.agency`, with the home folder set to a fixture folder, gives a file source in that folder.

### Task 3: `minimalOptions`

**Files:**
- Modify: `stdlib/agents/brains/minimal.agency`

Move the options record out of `minimalBrain` into an exported function with a docstring:

```agency
export def minimalOptions(settings: AgentSettings, extraTools: any[]): any {
  return {
    ...modelOptions(settings.model, settings.provider),
    tools: [...codingFileAndShellTools(commandJudgeOf(settings)), ...extraTools],
    spillToolResultsOver: AGENT_SPILL_OVER
  }
}
```

`minimalBrain` calls it. `tests/agency/agents/brainMinimal.agency` passes unchanged.

### Task 4: the brain

**Files:**
- Create: `stdlib/agents/brains/learntest.agency`
- Modify: `stdlib/agents/agency.agency`
- Create: `tests/agency/agents/brainLearntest.agency`, `tests/agency/agents/brainLearntest.test.json`
- Create: `tests/agency-js/learntest-brain/agent.agency`, `test.js`, `fixture.json`, and a fixture file `tools/series.agency`

**Tests, written first.**

In `tests/agency/agents/brainLearntest.agency`, modeled on `brainScripttest.agency`, with a scripted model:

1. `offersLearnAfterTheFourTools`: the first request's tools are `read`, `bash`, `edit`, `write`, `learn`, then the caller's tool.
2. `givesTheModelThePrimer`: the system text contains "You can gain tools", the stdlib folder's path, and the index path, and still contains the minimal brain's coding rules.
3. `theSchemaShowsOnlyFileAndNames`: the `learn` tool's parameters are `file` and `names`. `settings` and `extraTools` are absent.

`learnFromFile` is not exported, and it should stay that way. Every test below reaches it the way a model does: a scripted client calls the `learn` tool. So these tests are in `tests/agency-js/learntest-brain`, modeled on `tests/agency-js/coordinator-session-tools`, with a scripted client that records every request and a handler that records every interrupt.

4. The model calls `learn` with `names: []`. The call fails with the message that asks for names, no `std::run` was raised, and the conversation continues in the caller's loop.
5. The model calls `learn` with a path that exists nowhere. The call fails with the message from `_learnSource`, and no `std::run` was raised.

The main script is: call `learn` on the fixture file, call the learned tool, answer, then on a second turn call the learned tool again and answer.

6. The learned tool is absent from the first request and present in the request the handoff makes.
7. The learned tool is offered under its own name, with no prefix.
8. The handoff's request still holds the user's original message and the primer, and holds the caller's `context` when one was passed.
9. The learned tool runs and its result reaches the model.
10. On the second turn, the first request offers the learned tool.
11. A second scenario learns from a stdlib path (`math.agency`, function `add`) under a handler that records each interrupt. The `std::run` interrupt's data has `module: "std::math"`. This is the check that a stdlib path becomes a module source all the way through.
12. A third scenario learns a function named `read` from a fixture file. It fails with "A tool named 'read' is already in your tools, so this function cannot be learned in this conversation." No `std::run` was raised, the conversation continues in the caller's loop, and the tool list is unchanged.
13. A fourth scenario pauses and resumes inside the handoff. The scripted model calls `learn` on the fixture file and then calls the learned tool. The handler approves the `std::run` whose `function` is `<inspect>` and gives no answer to the learned call's `std::run`, so that interrupt reaches the JavaScript side with a checkpoint. The test resumes the checkpoint with an approval. It asserts that the learned tool ran, that its result reached the model, and that the records hold the tool once. This is the check that the handoff body does not run `learnSessionTools` a second time on resume. `tests/agency-js/learned-call-resume` shows how to pause and resume a learned call.

**Steps:**

1. Write `stdlib/agents/brains/learntest.agency` as in decision 4, with a `@module` doc comment and the final docstring for `learn`.
2. In `stdlib/agents/agency.agency`: add `"learntest"` to `AgencyAgentBrain`, add an entry to `agencyAgentBrains()` with the description "A trial: the minimal brain, plus a tool that learns new tools from Agency files on disk", add the arm to the `match` in `agencyAgent`, and add the name to the `brain` parameter's doc line.

### Task 4b: one run against a real model (costs model money)

This step waits for the owner's go-ahead. It comes here, before the index is curated and the docs are written, because it tests the largest risk: that the model never calls `learn`.

1. Before the build in "The order of work", write a three-line `stdlib/agents/prompts/learnable-tools.md` with `data/tech/hackernews.agency`, `wikipedia.agency`, and `data/wikidata.agency`. A Markdown file needs no compile, so task 5 can replace it later without a second build.
2. Run the built command from an empty folder outside the repo. Inside the worktree, the stdlib folder is under the working directory: reads of it would raise no outside-the-folder prompt, the model could find tools by grepping the repo's own docs, and a relative path would be found in the working directory first. None of that is what a user's run looks like.

```
mkdir -p ~/learntest-check && cd ~/learntest-check
node <worktree>/packages/agency-lang/dist/scripts/agency.js agent --brain learntest \
  --approve FileRead --approve std::run --approve Network --approve std::hackernews \
  -p "What are the top five stories on Hacker News right now?"
```

`FileRead` covers reading the index and the stdlib sources. `std::run` covers the inspection and each learned call. `std::hackernews` is the effect the connector raises. Shell commands are not approved, so a `curl` is rejected in this one-shot run and the trace shows that the model tried one.

3. If a grep through the `bash` tool is rejected under these flags, tell the owner which effect it raised before adding a flag.
4. Read the trace. Confirm the model read the index or grepped, called `learn`, and called the learned tool. If it answers from a `curl` command and never calls `learn`, change the primer's wording and run again before going on. Tell the owner what the model did either way.

### Task 5: the index file

**Files:**
- Create: `stdlib/agents/prompts/learnable-tools.md`
- Create: `lib/stdlib/learnableIndex.test.ts`

**Steps:**

1. The one `make` regenerated `lib/stdlib/stdlibModules.data.ts` and the stdlib reference pages for the two new modules. Commit the regenerated files.
2. For each candidate in decision 5, write a throwaway Agency program in the worktree that calls `learn` on the module with an empty `names` list under `with approve`, and prints how many tools came back or the failure. Keep the modules where at least one function is learned. A module whose top-level code needs a credential to load is kept, and its line says which credential.
3. Write one line per kept module: the path relative to the stdlib folder, a colon, and one sentence taken from the module's `@summary`. Delete the throwaway program.
4. Write `lib/stdlib/learnableIndex.test.ts`: it reads the index, and for each line asserts the file exists under `stdlib/` and that `STDLIB_MODULES` has a non-empty entry for its module name. It also asserts the file has at least one line, so an empty index cannot pass.
5. Read the primer's list of categories against the final index. If a category has no module left in the index, remove it from the primer. The primer is Agency source, so a change here needs `make` again; check the list before the build if the candidates are already known to fail.

### Task 6: the dev docs

**Files:**
- Modify: `docs/dev/agents/agent-brains.md`, `docs/dev/stdlib/agency-function-tools.md`

1. In `agent-brains.md`: change "five brains" to six, add `learntest` to the list, and add a section "The learntest brain" after "The scripttest brain". The section covers the mechanism and the rules only: what the two additions are, why `learn` is a handoff, the path rules, which interrupts are raised and that the brain approves none, how the index is kept true, and that the harness treats the brain as minimal. It states two rules a later change could break: the `.agency` rule limits what the parent reads before any approval, and learned tools belong to the run, so two `agencyAgent` calls in one run share them.
2. In `agency-function-tools.md`, "Coordinator records": the state and its two functions are in `std::agents/lib/learning`. Update the paths. Add one sentence that the `learntest` brain uses the same records.

No new file is added to `docs/dev/`, so the index in `CLAUDE.md` does not change.

### Task 7: verify

Run each of these once, from the worktree, with output saved to a file:

1. `pnpm run typecheck`
2. `pnpm test:run lib/stdlib/learnSource.test.ts lib/stdlib/learnableIndex.test.ts lib/stdlib/agentBrainStatics.test.ts`
3. `pnpm run agency test --check-capabilities` on `tests/agency/agents/brainLearntest.agency`, `brainMinimal.agency`, `brainScripttest.agency`, and `agencyAgent.agency`
4. `pnpm run agency test js` on `tests/agency-js/learntest-brain`, `coordinator-session-tools`, `learned-tools-resume`, and `learned-tool-parity`
5. The command-line agent's own tests that import the moved functions: `lib/agents/agency-agent/tests/toolPresentations.agency` and `toolWiring.agency`
6. `pnpm run lint:structure`
7. `pnpm run fmt:ts` on the new and changed TypeScript files only, and `agency fmt -i` on the Agency files this PR adds. Existing Agency files are not reformatted.

Then check the diff against `docs/dev/contributing/anti-patterns.md`, and open the PR. The full agency test suite runs in CI.

---

## What the build did differently

- **`learnSourceIn` takes the home folder and the stdlib folder as parameters**, and `_learnSource` passes the real ones. The tests use the real stdlib folder for the module cases, because `stdlibModuleName` always measures from it, and a fixture folder for the sibling-folder case.
- **Test 3, the schema check, is in the scripted-model test** with tests 4 to 13. The Agency test file holds tests 1 and 2.
- **`lib/stdlib/learnSource.ts` is on the Node-only list** in `eslint.node-exceptions.mjs`, beside `agencyFunctions.ts`. It checks files with the same Node helpers that file uses, and the learn it serves starts a process.
- **`tests/agency/agents/agencyAgent.agency` counts six brains** and runs the new one.
- **All 25 index candidates can be learned**, so the index lists all of them and the primer's categories did not change.
- **Task 4b has not been run.** It waits for the owner's go-ahead.

## Review focus

Conditions that are easy to get wrong. Each has a test.

1. **A stdlib path must become a module source, and the module name must come from `stdlibModuleName`.** A stdlib file learned as a file source would show a file path in the approval prompt where a policy rule expects a module name, and it would go through the validator that trusted stdlib code skips. The module name is never built from text the model wrote. (Task 2, tests 1, 6, and 9; task 4, test 11.)
2. **The handoff must offer the same tools as the brain, plus the new ones.** If the two lists are built differently, a tool vanishes after the first learn. Both come from `learntestExtras`. (Task 4, tests 6, 8, and 10.)
3. **A failed learn must leave the conversation in the caller's loop.** The `?` operator returns the failure before `endTurn()` runs. (Task 4, tests 4, 5, and 12.)
4. **No handler is added anywhere.** The brain file contains no `handle` block and no `with approve`. (Read the diff.)
5. **The coordinator is unchanged.** Task 1 is a move. The three existing learning tests pass with only their import lines changed.
6. **A run that pauses inside the handoff must resume without learning twice.** A learned call's `std::run` can pause the run after the records were added. On resume the handoff body must continue from the `llm` call. (Task 4, test 13.)
7. **The model must be able to act on every failure message.** No message tells it to choose a namespace or use an argument the tool does not have. (Task 4, tests 4, 5, and 12.)

---

## Phase 2 outline: the measurement

This phase is a suite in `~/agency-evals`, and it gets its own plan. It is outlined here because phase 1 exists to make it possible.

**Phase 2 needs an agency-lang build that contains the brain.** If the suite's containers install the published package, phase 2 waits for a release, which should be batched with other work that needs one. If the suite can run against a local build, it does not wait. The phase 2 plan decides which.

**The tasks.** About ten questions that a stdlib function answers directly and that are awkward with bash alone. Examples: the top stories on Hacker News, a company's latest filing from EDGAR, a fact from Wikidata, federal spending for an agency, text from an image by OCR. Tasks are chosen from modules that need no API key where possible, so a run needs only the model's key. Each task has an answer a grader can check.

**Three runs of the same tasks.**

| Run | The agent | What it shows |
|---|---|---|
| A | `minimal` | The baseline: the model improvises with `curl` and scripts |
| B | `learntest` | Whether the model looks for a tool, learns it, and does better or cheaper than A |
| C | `minimal`, with the same stdlib functions passed in `extraTools` | The same capability paid for up front instead of on demand |

Run C needs no new brain. Its agent is a short Agency program that calls `agencyAgent(brain: "minimal", extraTools: { main: [...] })`.

Run C can get its tools two ways, and the phase 2 plan has to pick one. If the program imports the stdlib functions and passes them in, they run in the same process, with no `std::run` and no process start, so B against C would also measure those. If the program calls the library `learn` before the first turn and passes the result in, the tools are the same child-process tools that run B uses, and the only difference left is up front against on demand. The second is the cleaner comparison.

**One more run, on the current coding benchmark:** `minimal` against `learntest`, on tasks where nothing needs learning. This shows what the primer and the extra tool cost when they are not used.

**What each run records:** whether the task passed, the cost, the number of model requests, whether `learn` was called and on which file, the number of requests before the first learned call, and the cached input tokens. Cached tokens show what each learn costs in cache misses.

**What the results would mean:**

- B passes as often as C at lower cost: the idea works, and a small tool list plus `learn` is a real alternative to a large one.
- B passes less often because the model never calls `learn`: discovery is the problem, and the next experiment is the wording and size of the primer.
- B passes as often but costs more than C: learning works, and the cost is the cache miss or the discovery rounds. The cached-token numbers say which.

---

## Questions for the owner

1. **The name.** `learntest` follows `scripttest` and `spawntest`. Say so if you want a different one.
2. **Relative paths.** Decision 2 looks up a relative path in the working directory first and the stdlib folder second. This lets the index list short paths. The alternative is that the index lists full paths, which it cannot do in a file written before install. I recommend the two-step lookup.
3. **The index's home.** `stdlib/agents/prompts/` already ships. A file at the top of `stdlib/` would be easier for a model to stumble on, and would need one new line in `package.json`. I recommend the prompts folder.
4. **The manual check.** It costs a few cents on a real model. It is task 4b, a step that waits for your go-ahead.
5. **Learned tools belong to the run.** Two `agencyAgent` calls in one run share them, because the records are in one global. The architecture review (finding 1.1) recommends accepting this for the trial and saying so in the dev doc.
