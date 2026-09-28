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
   `tooManyHandoffs` if another handoff call that could run shares the
   round. Other calls may share the round, and they run first (see
   "Other calls in the same round" below).
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
4. When the body returns, `closeHandoff` removes every message tagged
   with this dispatch's scope key and pushes a user-role
   `[name finished. <result>]\nContinue with the user's request.`
   The return value is always included, even when it repeats the body's
   last assistant message. A rejection takes the same route with the
   text an ordinary tool message would have carried.

   A failure, or an aborted result from an outer guard trip, gets the
   stopped text instead, which says
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
   is delivered (`runHandoffGate`). A guard that tripped during the
   first batch stops the round before the body starts, and feedback
   given at that approval reaches the body. If the gate ends the round,
   for example because the user rejected the trip, the handoff's tool
   call is answered with a tool message saying it was not run. The
   handoff's call has no result at that point, and a thread that kept
   it that way would be rejected by the provider on its next request.
3. The second batch runs the handoff alone. Its drop step removes only
   its own call, and the thread becomes:

```
assistant: "Checking the parser."  [updateStatus]
tool:      updateStatus → "ok"
...the explorer's work...
user:      [explorer finished. <result>] Continue with the user's request.
```

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
Only handoffs that pass every other check count. A handoff refused for
another reason (removed after repeated rejections, say) would not run
anyway, so it does not stop another handoff from running. The list of
handoffs that count is computed once per round, in a step, because the
checks read state that changes as calls finish.

## Ending the turn from a tool

Two `std::thread` functions let a tool steer what the loop does once the
tool returns. `endTurn()` ends the caller's `llm()` call after this
round with the tool's return value as the answer, so the model makes no
follow-up call to restate it. `handBack(message)` replaces a handoff's
default hand-back text. Both are marks on the current tool invocation,
written onto its branch `StateStack` the way `attachToReply` queues an
attachment (`markTurn`, `setHandBack`, `drainTurnMarks`), so they
serialize and a pause after the call keeps them. The helpers in
`lib/stdlib/thread.ts` refuse a call outside a tool invocation with a
statelog error and no effect.

A mark lands on the innermost tool invocation on the stack: a helper the
body calls from code marks the tool, and a tool of the body's own
`llm()` marks that inner call. A handoff called from code inside another
tool's body marks that tool, since there is no loop between them.

### Draining and recording

`runInvokeStep` drains the marks in one place, right after the tool
returns and before the outcome is classified, and hands them to every
outcome path as data. A result that carries interrupts keeps its marks on
the stack for the resumed invoke. A finished call records an entry in
`runnerState.turnMarks[round][callIndex]` (`recordTurnMark`), but only
when something was set, and the answer value only with `endTurn`:
`runnerState` rides in every later checkpoint. The value is the return
value before the loop's "ran successfully" placeholder, unwrapped from a
`success(...)`. A tool that failed, was rejected, or was aborted has its
`endTurn` dropped with a warning; `handBack` from a failing handoff still
works.

### The hand-back

`closeHandoff` in `lib/runtime/handoff.ts` strips the body's system
messages, then pushes the hand-back: the custom text when `handBack` set one and the outcome
allows it, else the default for the outcome. A rejection keeps its text,
since it tells the model the user said no, and an empty message is
ignored, since a follow-up request needs a user-role message in front of
it. A success with `endTurn` pushes nothing yet and returns a
`DeferredHandBack`, which the invoke step stores in the mark for the
decision step to push if the turn goes on after all.

### The decision step

After the round's batches, one step `round.N.endTurn` runs
`runEndTurnStep`: decide from the round's marks, apply, record
`runnerState.turnEnded[round]`, and drop the marks. Deciding after every
call has run means a handoff in the round still runs even when a
first-batch tool marked the turn; deciding earlier would leave its call
unanswered on the assistant message.

`decideEndTurn`: a mark counts only when its call was the last to run in
the round, a handoff (alone in the second batch) or an ordinary tool that
was the round's only dispatched call that ran. An ordinary tool beside
other calls never saw their results, so its mark is dropped. Then the
fallbacks: a reply attachment waiting for the round boundary (the model
must see it), a value that does not match the caller's `responseFormat`
(checked with `extractStructuredResponse`, like the final assistant
message), or a non-string value with no `responseFormat`. Every dropped
or fallen-back mark is a statelog warning (`warnType: "endTurn"`).

`applyEndTurnDecision`: on "end", `endThreadWithAnswer` replaces a
trailing assistant message that carries no tool calls (the body's JSON,
or the caller's own text left by `dropHandoffToolCall`) and pushes
otherwise, so two assistant messages never sit side by side; the
Anthropic client would merge them into JSON followed by prose. On
"continue", every deferred hand-back is pushed. The loop then runs
`guardGate.final` and returns the recorded value, the string or the
parsed structured value.

### Scope

`endTurn(scope: "turn")` ends every enclosing `llm()` call up to the
user's turn. When the decision ends a call whose loop runs inside a tool
body (`isInsideToolCall()`), `applyEndTurnDecision` writes the same mark
onto the loop's own `stateStack`, which is the enclosing tool's branch
stack, so the enclosing loop ends too when that tool returns. The
default `"llm"` ends only the nearest call; the body's code still runs
and the outer model gets its follow-up. Code is never skipped at any
level.

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
  other calls. The model cannot tell which tools are handoffs, so the
  refusal names them.
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
  `dropHandoffToolCall`, `closeHandoff`, and the end-turn decision:
  `recordTurnMark`, `decideEndTurn`, `applyEndTurnDecision`,
  `runEndTurnStep`.
- `lib/runtime/toolInvocation.ts` — the frame a tool body runs in, failure
  tiers, and result capping, moved out of `prompt.ts` for its line cap.
- `lib/runtime/state/stateStack.ts` — `markTurn`, `setHandBack`,
  `drainTurnMarks`.
- `lib/stdlib/thread.ts` and `stdlib/thread.agency` — `endTurn` and
  `handBack`.
- `lib/runtime/prompt.ts` — the gate verdict, the two dispatch
  batches, the `.handoffDropCall` step, `invokeOnThread` (enters and
  exits the scope), and `pushToolReply`.
- `lib/runtime/state/messageThread.ts` — `messageScopes`,
  `enterHandoffScope`, `removeHandoffScoped`.
- `lib/runtime/state/threadStore.ts` — `viewWithActive`.
- `tests/agency-js/handoff/` — the end-to-end suite.
- `tests/agency-js/end-turn/` — the end-to-end suite for `endTurn` and
  `handBack`.
- `stdlib/agents/oracle.agency`, `explorer.agency`, and the coordinator
  wrappers under `lib/agents/agency-agent/brains/coordinator/subagents/`
  — the handoff functions that ship.
