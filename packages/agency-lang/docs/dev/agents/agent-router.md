# The router

The coordinator model reads every user message, picks a subagent, writes a
brief, and calls it. With a slow coordinator model that first call is most
of the wait before any work starts. The router replaces it for the two
subagents most turns go to: a decision model reads the message and answers
`research`, `code`, or `coordinator` in a few hundred milliseconds, and the
agent calls the subagent itself.

## When it runs

`mainAgent` in `lib/agents/agency-agent/brains/coordinator/coordinator.agency`
asks for a route before its `thread(label: "main")` block, when all of
these hold:

- The `router` slot is set.
- The prompt is plain text. The harness sends the main target
  `[message, ...attachments]` (`dispatchToBrain` in `lib/turn.agency`), so a
  prompt of one part is plain text and a prompt with attachments is not.
- The text is at most `ROUTE_MAX_CHARS` (8,000) characters. The REPL puts
  every pending note above the message in one string, and a note can be the
  whole output of a `!` command. The router was not measured on such
  prompts, the subagent would get the note as its task, and a long one can
  exceed what the decision model accepts.
- The harness did not rewrite the message. `dispatchToBrain` replaces a
  slash command with its skill's text, and after a coder changed folders it
  puts the new folder's project block above the message. Either way the
  text is not what the user typed: a skill's text often reads like a coding
  task, and a project block can bury the question. `dispatchToBrain` records
  the rewrite with `setMessageRewritten` (`lib/rewrittenMessage.agency`), and
  `routeFor` reads it.

Otherwise the coordinator takes the turn.

## The slot

`router` is a slot of the `derived` kind, beside `embedding`
(`lib/agents/agency-agent/lib/slots.agency`). It is set with

```
agency agent --model router=openrouter/jev-1.14
```

or `slots.router` in a preset, or `settings.model.slots.router`, or
`/model router=...` in a session. With none of these, the default below
applies. The value must be in the `provider/model` form. The provider must
be one that answers decisions (`DECISION_PROVIDERS`: `typesafe`, `laya`,
`openai`, `openrouter`, `llama-cpp`). That list is used only to parse this
slot, so `typesafe` and `laya` never reach a chat slot. A local session
(`--local`, a local preset, `/local`) keeps a router the user set: it may
route with a hosted decision model. `getRouterModel()` and
`getRouterProvider()` in `shared.agency` read the resolved slot.
`docs/dev/agents/agent-presets.md` covers the layers.

The startup header prints a `Router` line under the main and reasoning
models when the slot is set, so the user can see where their messages go.

## The default router

When nothing sets the router, a hosted session routes with
`openrouter/jev-1.14`, but only when `OPENROUTER_API_KEY` is set. The
chat provider does not matter: an Anthropic session with an OpenRouter key
routes too.

The default is the `router` row of `SLOT_DEFAULTS` in `lib/slots.agency`.
It reaches the resolver as a fifth layer, named `default`, after
`settings`. Because it is last, every other way of setting the router wins
over it. A slot it fills shows `(default:per-slot)` in `/model`. It is a
layer, not a value from `priceDefault`, because `priceDefault` is pure and
its tests assert exact values: a key check inside it would make those
tests depend on the shell.

The key is checked once, at startup. `pickModelsForAgent` calls
`defaultSlots()` in `shared.agency`, which keeps the rows of
`SLOT_DEFAULTS` whose provider has its key, and stores the result with
`setStartupModelFlags`. `applyModelRequest` and `switchModel` pass the
stored rows to the resolver. Reading the key later would happen inside
the policy handler, where the `std::env` read becomes a prompt under the
`recommended` policy, and under a handler that rejects, `env()` returns a
failure that `missingProviderEnvVar` reads as a key that is set. So
nothing `/model` or `/preset` calls may call `defaultSlots()`.

A one-shot run (`agency agent -p "..."`, or a prompt on stdin) gets the
default too, because `pickModelsForAgent` runs before the agent branches
on one-shot. A one-shot run prints no header, so nothing in its output
shows the router. A script that should not route passes
`--model router=off`.

A local session gets no default. Its slots are built by
`configureLocalModel`, which never sees the `default` layer. `/local`
carries the hosted session's router into the local one only when the user
set it: `explicitRouterSpec()` returns `""` for a router that came from
the default layer.

A resumed session uses the default slots it was saved with. The restore
runs after `pickModelsForAgent` and replaces every `let` global,
including the stored rows (`docs/dev/agents/agent-sessions.md`, "How a
resume works").

## Turning the router off

`off` is a router value that means no router. It works in every place a
router value goes: `--model router=off`, `/model router=off`, a preset's
`slots.router`, and `settings.model.slots.router`. `lacksProviderForm` in
`lib/models.agency` is the one check behind all four, and it lets `off`
through for a slot that has a default. `resolveSlot` turns `off` into an
empty model and provider, with a `via` such as `in-session:off`, and the
rest of the agent reads an empty model as no router. In a local session,
`localRouterSlot` reads `off` the same way as no value.

`off` means nothing in a slot with no default. `embedding=off` is refused
with the provider-form message, and `main=off` names a model called `off`.

## The question

`router.agency` makes one decision call on a fresh `thread(label: "route")`
that holds only the user's message. The thread before the prompt is the
decision model's state, and the prompt is the question
(`docs/dev/llm/decision-models.md`, "The state"), so the model reads the
message and answers about it. The question and the answer never reach the
main thread.

The call passes `type: "decision"`, so a model the catalog does not list
as a decision model works too. It has `retries: 0` and a 3 second timeout
(`ROUTER_TIMEOUT`): the
router is fast or it is skipped. It asks once; the same request gives the
same answer, so voting gains nothing.

The question is the text that was measured on 60 logged turns:

```
Which agent should handle the user's latest message?

research: <description>
code: <description>
coordinator: <description> Its other tools: <names>.
```

The descriptions are in the prompt and the union members are bare names.
Descriptions written in the prompt did as well as descriptions attached to
each option, so Agency needs no way to describe a union member. Names with
no descriptions made the model overconfident. Do not reword the
descriptions without measuring again.

The coordinator's line names its other tools: learned tools and skills,
generated tools, Claude skills, MCP tools, then the built-in ones, with the
two routed subagents left out, at most 30. Without the names, the model
sent a request that a learned tool answers in two seconds to the
researcher, because it did not know the tool existed. The per-user tools come first because the
router keeps the first 30. `mainAgent` reads them once per turn
(`userTools`) and gives the same lists to the router and to the
coordinator's call.

## Every doubt goes to the coordinator

A failed call, a timeout, a missing key, a missing confidence, a confidence
below `ROUTE_MIN_CONFIDENCE` (0.7), and the answer `coordinator` all route
to the coordinator. At 0.7 no logged turn went to a wrong subagent. The
router never makes a turn fail: `try` turns a thrown error into a failure.

A cancel is not a failure. `try` passes an abort through, so a cancelled
router call stops the turn and does not fall back to the coordinator.

A failed call is reported once per router model, with a dim line naming the
error. A missing key or a misspelled model name fails every turn, and
without the line the user would think routing is on. A different router
model is reported again.

## A routed turn

```ts
const result = match(routed.route) {
  "research" => researchTurn(routed.text)
  "code" => replyText("The coder", codeAgent(routed.text))
  _ => llm(prompt, mainOptions(offeredTools(user, turnStart)))
}
```

The subagent is called from code, inside the main thread block, with the
user's message as its task. The coordinator model is not called. The code
arm does not use `coderTurn`, which opens a `code` thread of its own: a
routed coder works on the main thread, so the next turn sees its work. The
system prompt on the first turn and `addGlobalInstructions()` run first,
so the main thread is set up the same way on either path.

The stdlib agents push their persona with `expires: "llmCall"`, so it is on
the main thread only while the subagent's `llm()` call runs
(`docs/dev/language/handoff-functions.md`, "Called from code"). The global
instructions also expire with that call. The subagent's prompt and reply
stay on the main thread, so the coordinator reads them on a later turn.

The user's message is not pushed as a message of its own. The thread gets
the subagent's prompt, which for the researcher is the user's text followed
by the REPL style notes and the global instructions. When the coordinator
calls a subagent as a tool, the user's message is on the thread as well.

`researchAgent` sets the memory id to `"research"`; `mainAgent` sets it back
to `"main"` after the routed call.

## Interrupts and sessions

The subagent runs inside `mainAgent`, under the same
handler chain as the coordinator's call, so it raises the same interrupts
under the same policy. The route is a local of `mainAgent`'s frame,
computed in a step, so a turn that pauses on an approval and resumes from
its checkpoint does not ask the router again.

## Known limits

- Deadlines and spend caps the user states are not passed on. The
  coordinator reads "take no more than five minutes" and passes
  `maxSeconds`; a routed turn uses the subagent's defaults.
- The subagent gets no brief. Most briefs in the logs added a research plan
  the researcher writes itself; some narrowed the task or added limits, and
  those are lost.
- Only `research` and `code` are routed.
- A question about the Agency language should go to the coordinator, which
  sets `agencyTopic` on `researchAgent`. The coordinator's line claims these
  questions, but no logged turn tested that.
- No coordinator on a routed turn: no memory recall, and no closing remark
  after the subagent.
- The confidence floor was measured on Jev. Another model's 0.7 can mean
  something else.

## Adding a routed subagent

Measure first: replay logged turns that went to the subagent through the
router with a description for it, and check that none goes to a wrong
subagent at the floor. Then add the description to the question, the
member to `Route`, an arm to the `match` in `mainAgent`, and the tool's
name to `ROUTED_TOOLS`, which keeps it off the coordinator's line.

## Tests

- `lib/agents/agency-agent/tests/routing.agency`: the router module: the
  floor, a missing confidence, a failed call reported once per router
  model, a cancel, the request's state, the question's text, the tool-name
  cap, and the caller's thread left alone.
- `lib/agents/agency-agent/brains/coordinator/tests/routedTurn.agency`: the
  turn: no router when unset, a research route, a code route on the main thread, a coordinator route, an
  attachment, a long message, and a rewritten message not routed, the tool
  names on the coordinator's line, the next turn, and a resume through the
  checkpoint.
- `lib/agents/agency-agent/tests/turn.agency`: `dispatchToBrain` marks a
  slash command rewritten and a plain message not.
- `lib/agents/agency-agent/tests/modelRequest.agency`, `presetRules.agency`,
  `slots.agency`, `localRouter.agency`: the slot, `off`, the key check in
  `defaultSlots`, and no default in a local start.
- `lib/agents/agency-agent/tests/resolution.agency`: the `default` layer
  under every other layer, and `off` over it.
- `lib/agents/agency-agent/tests/presetSession.agency`: the stored
  default through `switchModel`, and `explicitRouterSpec`.
- `lib/agents/agency-agent/brains/coordinator/tests/agentTurn.agency`: the
  header's `Router` line.
