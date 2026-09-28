# Handoff functions

A `handoff def` is a function that, when a model calls it as a tool,
continues the caller's conversation instead of starting its own. Its
`llm()` calls append to the caller's message thread, the tool call is
dropped, and one user-role message hands control back afterwards.

## Why

An ordinary tool runs on a fresh, empty `ThreadStore`. That is correct
for a leaf tool, and it exists because the caller's thread ends, at the
moment of the call, with an assistant message carrying the tool call.
Providers require a tool result right after that message, so nothing
else may be appended there.

A subagent called as an ordinary tool therefore starts blind and reports
back a summary. The coordinator never sees what the explorer read. A
handoff removes the dangling tool call instead of working around it, so
the body's messages can land on the caller's thread as valid history.

## What happens

1. The model calls a handoff tool. The `.gate` step refuses it with
   `tooManyHandoffs` if another handoff call shares the round. Other
   calls may share the round. They run first (see "Other calls in the
   same round" below).
2. The `.handoffDropCall` step edits the assistant message carrying the
   tool call, the last assistant message on the thread. Only the
   handoff's call is dropped. The other calls stay, so their tool
   results still pair with them. When the handoff was the only call,
   the text is kept and a message that was only the call is removed,
   so the thread reads as the user's request followed by the body's
   work. Nothing is written in its place: a model that sees dispatch
   narration in its history learns to write it instead of calling the
   tool.
3. `runInvokeStep` runs the body in a frame whose thread store is a
   view of the caller's store with the prompt's own thread active
   (`ThreadStore.viewWithActive`). That is the active thread for an
   ordinary prompt and a subthread for an `async` prompt; in either
   case the body's `llm()` calls land on the caller's thread. The view
   has its own active stack, so two prompts running at once cannot
   disturb each other. For the duration of the body the thread holds
   the dispatch's scope key (`MessageThread.enterHandoffScope`), and
   every system message pushed meanwhile is tagged with it in
   `messageScopes`, whichever code pushes it. The key is the tool name,
   the call id, and the nesting depth; the depth matters because a
   provider that sends no call ids leaves a handoff nested inside
   itself with the same name and the same empty id.
4. When the body returns, `finishHandoff` removes every message tagged
   with this dispatch's scope key and pushes a user-role
   `[name finished. <result>]\nContinue with the user's request.`
   The return value is always included, even when it repeats the body's
   last assistant message. A rejection takes the same route with the
   text an ordinary tool message would have carried.

   A failure, or an aborted result from an outer guard trip, goes
   through `finishStoppedHandoff` instead, which pushes
   `[name stopped before finishing: <reason>]` and a line saying the
   work so far is in the messages above and to continue with the user's
   request from it. The reason is the failure's error text, or
   `describeAbortCause` for an abort. A cancelled body (Esc, a race
   loser) gets no resume message; its system messages are removed on
   the way out.

The strip is keyed on the scope tags, not on a recorded position: memory
compaction rewrites the thread and shifts every index, and the tags ride
along with the messages it keeps (`setMessages` takes labels and scopes).
A tagged message that compaction summarized away is simply not there to
remove. The tags are serialized with the thread, so they survive a
checkpoint; the scope stack itself is not, because the `.invoke` step
re-enters it when a resume re-runs the dispatch.

The return value still reaches the code that awaited the call, through
`setResultOnBranch`, unchanged.

## Other calls in the same round

A model often calls a handoff alongside other tools, for example a
status update beside the explorer:

```
assistant: "Checking the parser."  [updateStatus, explorer]
```

Providers require every tool call to be answered by a tool result
before any other message. The body's messages are other messages, so
the handoff runs last. The tool loop splits the round into two batches:

1. The first batch runs every call except the handoff, concurrently, as
   an ordinary round does. The handoff's branch only takes its gate
   verdict there. A refused handoff answers the model with a tool
   message like any refused call.
2. Between the batches the guard gate runs and the approver's feedback
   is delivered (`round.N.handoffGuardGate`,
   `round.N.handoffGuardFeedback`). A guard that tripped during the
   first batch stops the round before the body starts, and feedback
   given at that approval reaches the body.
3. The second batch runs the handoff alone. Its drop step removes only
   its own call, and the thread becomes:

```
assistant: "Checking the parser."  [updateStatus]
tool:      updateStatus → "ok"
...the explorer's work...
user:      [explorer finished. <result>] Continue with the user's request.
```

The order the model listed the calls in does not matter, because calls in
one response are independent.

If a call in the first batch interrupts, the round pauses before the
handoff starts. On resume the first batch finishes and then the handoff
runs.

A first batch that finished is recorded in
`runnerState.finishedFirstBatches` and never re-run. This matters for a
body that pauses: `runBatch` pops every branch on the frame when a batch
succeeds, so re-running the first batch on resume would throw away the
paused body's branch, and the body would start over.

Two handoffs in one round are both refused, and the other calls still
run. Running one of them would be a guess about which the model wanted.

## Threads inside the body

`thread {}` still isolates. `subthread {}` inherits the caller's history
and does not flow back. System messages the body pushes are scoped to
the dispatch.

The caller's own system messages are live during the body. The body's
request sends the whole thread, so a subagent sees the caller's system
prompt alongside its own persona. That is the point of continuing the
conversation, and a subagent prompt that must not be read that way
belongs in an ordinary tool.

## Called from code

A handoff function called from code, not by a model, is an ordinary
function call. Functions are transparent to threads, so the body's
`llm()` calls append to the caller's active thread, and nothing is
stripped or handed back afterwards. A from-code call to the stdlib
oracle or explorer leaves the persona, the reads, and the answer on the
caller's thread. A caller who wants isolation writes
`thread { oracleAgent(...) }`. The
agents push their persona through `ensureSystemMessage` from
`std::thread`, which skips the push when the active thread already holds
it.

## Resume

A checkpoint taken inside a handoff holds the caller's thread with the
body's messages so far, scope tags included. On resume the
`.handoffDropCall` step is skipped (it is in `completedSteps`) and the
`.invoke` step re-runs to consume the user's response, as for any tool,
re-entering the scope on the way in. There is no orphaned tool call for
`threadRepair` to repair.

## Known limits

- One handoff per round. A round with two refuses both and runs the
  other calls.
- A served function (`agency serve`, HTTP or MCP) is invoked outside
  the tool loop, so a served handoff function is an ordinary call. Its
  docstring's promise to continue the conversation does not apply
  there.

## Files

- `lib/types/function.ts` — `FUNCTION_MARKER_KEYWORDS`, the `handoff`
  marker, and the two conversions the parser, formatter, and codegen
  read.
- `lib/parsers/parsers.ts` — the modifier table spreads the keyword
  list.
- `lib/runtime/agencyFunction.ts` — the runtime `ToolMarkers.handoff`.
- `lib/runtime/handoff.ts` — resume and refusal text, `handoffScopeKey`,
  `dropHandoffToolCall`, `finishHandoff`.
- `lib/runtime/prompt.ts` — the gate verdict, the two dispatch
  batches, the `.handoffDropCall` step, `invokeOnThread` (enters and
  exits the scope), and `pushToolReply`.
- `lib/runtime/state/messageThread.ts` — `messageScopes`,
  `enterHandoffScope`, `removeHandoffScoped`.
- `lib/runtime/state/threadStore.ts` — `viewWithActive`.
- `tests/agency-js/handoff/` — the end-to-end suite.
- `stdlib/agents/oracle.agency`, `explorer.agency`, and the coordinator
  wrappers under `lib/agents/agency-agent/brains/coordinator/subagents/`
  — the handoff functions that ship.
