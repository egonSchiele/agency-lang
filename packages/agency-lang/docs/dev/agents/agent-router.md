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

Otherwise the turn runs as it did before the router existed.

## The slot

`router` is a slot of the `derived` kind, beside `embedding`
(`lib/agents/agency-agent/lib/slots.agency`). It has no default, so routing
is off until it is set:

```
agency agent --model router=openrouter/jev-1.14
```

or `slots.router` in a preset, or `settings.model.slots.router`. The value
must be in the `provider/model` form. The provider must be one that answers
decisions (`DECISION_PROVIDERS`: `typesafe`, `laya`, `openai`,
`openrouter`, `llama-cpp`). That list is used only to parse this slot, so
`typesafe` and `laya` never reach a chat slot. A local session (`--local`,
a local preset, `/local`) keeps the router: it may route with a hosted
decision model. `getRouterModel()` and `getRouterProvider()` in
`shared.agency` read the resolved slot. `docs/dev/agents/agent-presets.md`
covers the layers.

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
two routed subagents left out, at most 30. In the test, the model sent a
request a learned tool answers in two seconds to the researcher, because it
did not know the tool existed. The per-user tools come first because the
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
  "research" => replyText("The researcher", researchAgent(routed.text))
  "code" => replyText("The coder", codeAgent(routed.text))
  _ => llm(prompt, mainOptions(offeredTools(user, turnStart)))
}
```

The subagent is called from code, inside the main thread block, with the
user's message as its task. The coordinator model is not called. The
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

Nothing changes. The subagent runs inside `mainAgent`, under the same
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
- The saving depends on the coordinator model. In the logs it was large
  with GLM 5.3 Flash (a median first call of 12.8 seconds) and small with
  Opus 4.8 (2.5 seconds).
- Long messages are not routed.
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
  floor, a missing confidence, a failed call reported once, a cancel, the
  request's state and question, the tool names and their cap.
- `lib/agents/agency-agent/brains/coordinator/tests/routedTurn.agency`: the
  turn: no router when unset, a research and a code route with no
  coordinator request, a coordinator route, an attachment and a long
  message not routed, the main thread after a routed turn, the next turn,
  and a resume through the checkpoint.
- `lib/agents/agency-agent/tests/modelRequest.agency`, `presetRules.agency`,
  `slots.agency`, `localRouter.agency`: the slot.
