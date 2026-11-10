# Review: `decision: true`, expiring personas, and the router

Plan: `docs/superpowers/plans/2026-11-10-decision-routing.md`

I checked the plan against the code in this worktree (which is at main,
`5b2ff90a8`), the smoltalk checkout at `~/smoltalk` (tag v0.21.0), and the
npm registry. Most of the plan's claims hold. The list at the end says
which ones I checked. The findings below are what I would change before
starting.

There are no blocking findings. Findings 1 to 4 should be settled in the
plan, because each one changes code that a task writes.

## Important

### 1. The router slot cannot name `typesafe` or `laya`, and `--local` refuses it

A slot value in the `provider/model` form is split by `parseModelSpec`
(`lib/agents/agency-agent/lib/models.agency:260`). It treats the part
before the slash as a provider only when that part is in
`knownProviders()` (`models.agency:363`). That list is the keys of
`MODELS` (openai, anthropic, google, openrouter, ...), `litellm`, `mlx`,
and `llama-cpp`. It does not have `typesafe` or `laya`.

So with the plan as written:

- `--model router=openrouter/jev-1.14` works.
- `--model router=typesafe/jev-1.14` and `--model router=laya/<model>`
  are refused with "needs the provider/model form", because the prefix
  is not a known provider and the provider comes back empty.

Part A adds `laya` so a local Laya server can answer decisions, and the
router is the first user of that. Task 6 should say what happens. I
would add a separate list of the providers allowed in the router slot
(`typesafe`, `laya`, `openai`, `openrouter`, `llama-cpp`) and use it
only when parsing that slot. Adding them to `knownProviders()` would
also let them into the chat slots, where they would not work.

The flag check has the same problem. `modelFlagsFromArgs`
(`lib/agents/agency-agent/lib/modelRequest.agency:117`) counts every
slot other than `embedding` as a chat slot. So
`--local <model> --model router=...` is refused with "Pass either
--model (hosted) or --local (local), not both." The plan says to write
the embedding rule once over a list of slots. That would allow the
router with `--local`, and then `LocalModel` (`modelRequest.agency:165-189`)
needs a `router` field and something has to read it. The plan should
say whether routing runs in a local session. Either answer is fine, but
it should be stated and tested.

### 2. Part C does need Part A, and the sketch leaves out `decision: true`

The plan says "Part C needs Part B. Neither needs Part A." Task 7 passes
`decision: true` and checks `answer.confidence != null`. Both come from
Part A. The order of the tasks is already right, so only the sentence
needs fixing.

The sketch in Task 7 does not pass `decision: true` in its `llm()`
options, though the text below it says to. The plan also says the
sketch type-checks against main, which is true only because the option
is missing. Add it to the sketch:

```ts
const route: Route = llm(question, {
  model: model,
  provider: provider,
  decision: true,
  retries: 0,
  timeout: 3s
})
```

### 3. The 30-name cap drops the tools the list exists for

Task 7 adds the coordinator's other tool names to the `coordinator`
line, capped at 30. Task 8 takes them from `turnTools(turnStart)` in
order. That order (`coordinator.agency:116-128`) is:

1. `mainAgentTools`: 18 named tools (16 after removing `researchAgent`
   and `codeAgent`), then `writableFileTools()`.
2. MCP tools.
3. Learned tools, then Claude skills, then generated tools.

The test that motivated the list was a learned tool. A user with one or
two MCP servers fills the 30 names before any learned tool is reached,
so the router never sees it.

Put the tools that differ per user first: learned tools, generated
tools, Claude skills, MCP tools. Then add the built-in tools until the
cap is reached.

The table in the background shows that a list of eight names was
tested. A list of 30 was not tested, and a long list on the
`coordinator` line may pull research turns away from `research`. For
example, the built-in tool names include file readers. Run the scoring
script once more with a realistic list of about 30 names, and put the
numbers in the pull request.

### 4. Say which decision entry wins when no provider is given

Task 2, change 1, says to find the model's decision entry "trying the
catalog's providers for that name". Some names have more than one
decision entry. `jev-1.14` is listed under both `typesafe` and
`openrouter` in smoltalk's catalog (`packages/smoltalk/lib/models.ts`,
around line 2630).

Today, a model whose first catalog entry is a decision entry switches to
that entry's provider (`modelProviderOverride`,
`lib/runtime/llmConfig.ts:41-44`). For `jev-1.14` that is `typesafe`.
The new rule should take the first decision entry in catalog order. Then
the only names whose behavior changes are those whose first entry is a
text entry, such as `gpt-6-luna`. Two smoltalk exports do this in one
expression:

```ts
getAllModels(modelData).find((m) => isDecisionModel(m) && m.modelName === name)
```

Two more details for the same change:

- `modelProviderOverride` takes `Partial<SmolConfig>`, which has no
  `decision` field. Say how the flag reaches it: a wider type or an
  extra argument.
- The function returns early when the call names the same model as the
  branch default (`llmConfig.ts:36`). So `decision: true` on the
  default model does not switch the provider. That is probably fine,
  because the default provider was chosen with that model. Add one
  sentence to the plan that says so, so the implementer does not
  "fix" it.

## Minor

### 5. The handoff fixtures named in Task 5 will not change

Task 5 says the fixtures in `tests/agency-js/handoff/` record the
persona's expiry and will change from `handoff` to `llmCall`. Those
tests use their own handoffs, which call `ensureSystemMessage` directly
(`tests/agency-js/handoff/agent.agency:4`). They do not run the stdlib
agents, so their fixtures stay the same. Only fixtures that run a real
stdlib agent change. Say this, so that an unchanged fixture is not taken
as a sign that the work is wrong.

`docs/dev/contributing/message-thread-tests.md` lists every
message-thread test case. Its `twoDispatches` line says the persona is
pushed fresh "through `ensureSystemMessage`". Add the new Task 5 cases
to that list and fix that line.

### 6. Tell the user when the router fails on every turn

Every doubt goes to the coordinator, which is right for a single turn.
But a missing `OPENROUTER_API_KEY` or a misspelled model name makes every
turn fail the same way. The user thinks routing is on, and every turn
costs a failed request. Print one dim line the first time the router
call fails in a session, with the error. The agent already checks the
embedding slot's key at startup (`embeddingKeyStatus` in
`lib/agents/agency-agent/shared.agency:204`) and could do the same for
this slot.

### 7. The confidence floor was measured on Jev only

The slot accepts any decision model: `gpt-6-luna`, any OpenRouter
decision model, or a chat model through `llama-cpp`. The floor of 0.7
was measured with Jev. Another model's 0.7 can mean something
different. Add this to the known limits and the dev doc.

### 8. `text` does not exist in `mainAgent`

Task 8's `match` passes `text` to the subagents. `mainAgent` takes
`prompt: string | (string | Attachment)[]` and has no `text` variable.
Get the text and the check for attachments from one `match` on
`prompt`, as `promptText` does (`coordinator.agency:194`).

### 9. The routed subagent changes the memory id

`researchAgent` calls `setMemoryId("research")`
(`subagents/research.agency:53`). On a routed turn this runs on the main
thread, after `mainAgent` set it to `"main"`. The next turn sets
`"main"` again. Check that nothing between the end of a routed turn and
the next `setMemoryId("main")` reads the id, such as memory saving at
the end of a turn.

### 10. The `llama-cpp` decision path needs plugin version 0.9.0

smoltalk's `llama-cpp` decision provider fails with "Your installed
smoltalk-llama-cpp has no decision support" on plugin versions before
0.9.0 (`packages/smoltalk/lib/decide.ts:201`). Version 0.9.0 was
published on 2026-11-10. Task 4's "Running against each backend" section
should give the minimum version.

### 11. A cancel during routing should cancel the turn

If the user presses Ctrl+C while the router call is in flight, the turn
should stop. It should not be caught by `try` and then run a full
coordinator call. The retry classifier passes an abort through
(`lib/runtime/llmRetry.ts:46`). Confirm that `try` does the same, and add
one router test for it.

### 12. What the main thread holds after a routed turn

On a routed turn the user's own message is never pushed to the main
thread as its own message. The thread gets the subagent's prompt, which
for the researcher is `withContext(task, context)`
(`stdlib/agents/researcher.agency:103`): the user's text followed by the
REPL style notes and the global instructions. When the coordinator calls
a subagent as a tool, the user's message is also on the thread. Put this
in the dev doc's description of a routed turn. Task 8's tests already
check the thread's contents.

### 13. Other stdlib agents keep their persona

The background says "each stdlib agent starts the same way". Four others
(`data`, `review`, `typescript/review`, `writing/review`) push their
system prompt with `systemMessage` when `threadIsNew()` is true, and keep
it. They are out of this plan's scope. Add one sentence saying so, so
that the docs updated in Task 5 do not claim every stdlib agent now
removes its persona.

## What I checked and found correct

- smoltalk 0.21.0 is on npm (published 2026-11-10). `smoltalk` is in
  `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, so the seven-day
  rule does not block the bump. A new transitive dependency of smoltalk
  is not excluded. If the install fails on one, that is the cause.
- `isDecisionCall` and `questionCapFor` read `registryRecord`, which
  returns the first entry found, so `gpt-6-luna` gets the text entry and
  the cap of 64 (`lib/runtime/decision/dispatch.ts:44-79`). smoltalk's
  `decide()` checks the cap again with the decision entry.
- A per-call key reaches `PromptConfig` through `restClientConfig` and
  `clientConfig` (`lib/runtime/prompt.ts:596-668`). `toSmolConfig`
  forwards it through `...metadata` (`lib/runtime/llmClient.ts:476`).
- smoltalk's "does not answer decisions" message is built from a list
  that is not exported (`builtInProviderNames`, `decide.ts:231`).
- An `llmCall` message pushed in a handoff body is claimed by the body's
  own `llm()` call, and not by the caller's call that is already running
  (`docs/dev/runtime/expiring-messages.md`, "Claiming an unkeyed
  message"). So Part B works when a model calls the agent as a tool.
- The six agents that use `ensureSystemMessage` each make one `llm()`
  call, except `researcher.agency`, which makes a second at line 119.
- The `derived` slot kind resolves to empty, keeps its provider in
  `promoteAll`, and is skipped by `applyResolved`
  (`lib/agents/agency-agent/shared.agency:333-385`). So `getRouterModel`
  must read `getResolvedSlots()`, as the plan says.
- `researchAgent` calls `endTurn()` only when `_insideToolCall()` is
  true (`subagents/research.agency:82`), so a call from code returns
  normally.
- A `match` used as a `const` value is lowered to statements with a
  result temp (`docs/dev/language/match-expression-positions.md`). I did
  not check how an interrupt inside an arm resumes. The resume test in
  Task 8 covers it.
