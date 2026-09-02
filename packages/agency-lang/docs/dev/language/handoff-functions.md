# Handoff functions

A `handoff def` is a function that, when a model calls it as a tool,
continues the caller's conversation instead of starting its own. Its
`llm()` calls append to the caller's message thread, and the tool-call
bookkeeping is replaced by two plain messages. The spec is
`2026-09-02-thread-sharing-invocation-spec.md` at the repo root.

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
2. The `.handoffMarker` step rewrites the last message on the thread,
   the assistant message carrying the tool call: its text is kept, the
   tool call is dropped, and `[dispatching name: args]` is appended. The
   thread length after the rewrite is recorded in
   `runnerState.handoffStarts[invocationKey]`.
3. `runInvokeStep` calls the body without installing a fresh
   `ThreadStore`. The body's `llm()` calls reach the caller's active
   thread through the branch frame, which `pr.parallel` pointer-shares
   (`shareThreads: true`).
4. When the body returns, `finishHandoff` removes every system-role
   message from the recorded start index onward and pushes a user-role
   `[name finished. <result>]\nContinue with the user's request.`
   The return value is always included, even when it repeats the body's
   last assistant message. A failure or rejection takes the same route
   with the text an ordinary tool message would have carried.

The return value still reaches the code that awaited the call, through
`setResultOnBranch`, unchanged.

## Threads inside the body

`thread {}` still isolates. `subthread {}` inherits the caller's history
plus the marker and does not flow back. System messages the body pushes
are scoped to the dispatch.

## Called from code

A handoff function called from code, not by a model, is an ordinary
function call. Functions are transparent to threads, so the body's
`llm()` calls append to the caller's active thread, and nothing is
stripped or handed back afterwards. The stdlib oracle and explorer used
to isolate themselves with a `thread(...)` wrapper; that wrapper would
opt them out of the handoff, so it is gone, and a from-code call now
leaves the persona, the reads, and the answer on the caller's thread.
This was decided on 2026-09-02 as a clean break. A caller who wants
isolation writes `thread { oracleAgent(...) }`. The agents push their
persona through `ensureSystemMessage` from `std::thread`, which skips
the push when the active thread already holds it.

## Resume

A checkpoint taken inside a handoff holds the caller's thread with the
marker and the body's messages so far. On resume the `.handoffMarker`
step is skipped (it is in `completedSteps`), the start index comes back
from `runnerState`, and the `.invoke` step re-runs to consume the user's
response, as for any tool. There is no orphaned tool call for
`threadRepair` to repair.

## Known limits

- One handoff per round. A mixed round refuses the handoff and runs the
  siblings.
- The marker carries the arguments as JSON with no cap. If a brief
  turns out to be large enough to matter, cap it there.
- An `llm()` call that passes explicit `messages`, or an `async` prompt
  (which runs on a subthread that is not the active thread), holds a
  thread that is not the store's active thread. A handoff inside such a
  call lands the body's messages on the active thread and the marker
  and resume on the call's own thread. Neither is invalid, but they are
  not the same transcript.
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
- `lib/runtime/handoff.ts` — marker, resume, and refusal text;
  `applyHandoffMarker`, `finishHandoff`.
- `lib/runtime/prompt.ts` — the gate verdict, the `.handoffMarker`
  step, the store skip in `runInvokeStep`, and `pushToolReply`.
- `tests/agency-js/handoff/` — the end-to-end suite.
- `stdlib/agents/oracle.agency`, `explorer.agency`, and the coordinator
  wrappers under `lib/agents/agency-agent/brains/coordinator/subagents/`
  — the handoff functions that ship.
