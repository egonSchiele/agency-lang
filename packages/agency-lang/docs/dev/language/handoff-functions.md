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
   `handoffNotAlone` if any other call shares the round.
2. The `.handoffDropCall` step edits the last message on the thread,
   the assistant message carrying the tool call: its text is kept and
   the tool call is dropped. A message that was only the call is
   removed, so the thread reads as the user's request followed by the
   body's work. Nothing is written in its place. An earlier version
   appended `[dispatching name: args]` here; a model that saw a few of
   those in its history started writing that text as its reply instead
   of calling the tool, and then nothing ran.
3. `runInvokeStep` runs the body in a frame whose thread store is a
   view of the caller's store with the prompt's own thread active
   (`ThreadStore.viewWithActive`). That is the active thread for an
   ordinary prompt and a subthread for an `async` prompt; in either
   case the body's `llm()` calls land on the caller's thread. The view
   has its own active stack, so two prompts running at once cannot
   disturb each other. For the duration of the body the thread holds
   the dispatch's scope key (`MessageThread.enterHandoffScope`), and
   every system message pushed meanwhile is tagged with it in
   `messageScopes`, whichever code pushes it.
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

## Threads inside the body

`thread {}` still isolates. `subthread {}` inherits the caller's history
plus the marker and does not flow back. System messages the body pushes
are scoped to the dispatch.

The caller's own system messages are live during the body. The body's
request sends the whole thread, so a subagent sees the caller's system
prompt alongside its own persona. That is the point of continuing the
conversation, and a subagent prompt that must not be read that way
belongs in an ordinary tool.

## Called from code

A handoff function called from code, not by a model, is an ordinary
function call. Functions are transparent to threads, so the body's
`llm()` calls append to the caller's active thread, and nothing is
stripped or handed back afterwards. The stdlib oracle and explorer used
to isolate themselves with a `thread(...)` wrapper; that wrapper would
opt them out of the handoff, so it is gone, and a from-code call
leaves the persona, the reads, and the answer on the caller's thread.
A caller who wants isolation writes `thread { oracleAgent(...) }`. The
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

- One handoff per round. A mixed round refuses the handoff and runs the
  siblings.
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
- `lib/runtime/prompt.ts` — the gate verdict, the `.handoffDropCall`
  step, `invokeOnThread` (enters and exits the scope), and
  `pushToolReply`.
- `lib/runtime/state/messageThread.ts` — `messageScopes`,
  `enterHandoffScope`, `removeHandoffScoped`.
- `lib/runtime/state/threadStore.ts` — `viewWithActive`.
- `tests/agency-js/handoff/` — the end-to-end suite.
- `stdlib/agents/oracle.agency`, `explorer.agency`, and the coordinator
  wrappers under `lib/agents/agency-agent/brains/coordinator/subagents/`
  — the handoff functions that ship.
