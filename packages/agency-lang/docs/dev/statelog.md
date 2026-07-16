# Statelog

## Overview

Statelog is an observability and tracing system for Agency programs. The `StatelogClient` (`lib/statelogClient.ts`) captures structured execution events — graph topology, node lifecycle, LLM calls, tool executions, and edge transitions — and sends them to a remote Statelog server for monitoring and debugging.

## Configuration

Statelog is configured via `AgencyConfig.log`:

```json
{
  "log": {
    "host": "https://agency-lang.com",
    "projectId": "my-project",
    "apiKey": "...",
    "debugMode": false
  }
}
```

- **`host`** — Statelog server URL. Can also be set to `"stdout"` to output JSON logs to the console instead of making HTTP requests. If not set, all logging methods are no-ops.
- **`projectId`** — groups logs by project in the Statelog dashboard.
- **`apiKey`** — authentication token. Can also be set via the `STATELOG_API_KEY` environment variable.
- **`debugMode`** — when true, logs debug info to the console.

A `traceId` is auto-generated per execution via `nanoid()`, ensuring all events from a single graph run appear together in the dashboard.

## What gets logged

### Graph structure
At the start of execution, the full graph topology is logged: all node IDs, all edges (with conditional flag), and the start node.

### Node lifecycle
- **`enterNode(nodeId, data)`** — when execution enters a graph node
- **`exitNode(nodeId, data, timeTaken)`** — when execution leaves, with elapsed time in ms

### Hooks
- **`beforeHook(nodeId, startData, endData, timeTaken)`** — before-node hook execution
- **`afterHook(nodeId, startData, endData, timeTaken)`** — after-node hook execution

### LLM calls
- **`promptStart(model, threadId, messageCount, toolCount, hasResponseFormat, maxTokens, label)`** — fired immediately before an LLM request is dispatched. Small payload: the request shape, not its content. Pairs with a terminator by span + order (the nth start in an llmCall span pairs with the nth terminator: a `promptCompletion`, an `error` with errorType `llmError`, or a `promptCancelled`). An unpaired start means the call never finished — the signature of a hung or killed-mid-call run, and the live in-flight indicator in follow mode. `label` is the call's `llm(label: "...")` debug tag, or `null`.
- **`promptCompletion(messages, completion, model, timeTaken, tools, responseFormat)`** — logs the full message history, model response, model name, tools provided, and response format. Each entry of `messages` carries a `label` key when that message has a debug label; unlabeled messages have no `label` key at all, so logs for programs that never label stay byte-identical.

### Message debug labels

`llm()`, `userMessage()`, `assistantMessage()`, and `systemMessage()` all take an optional `label`. It exists so a log reader can tell, say, a verifier's injected message from a real user turn. Labels are **observability-only and never sent to the provider** — `runPrompt` strips `label` off `clientConfig` before the config reaches smoltalk (the same way it strips the retry fields), and `lib/runtime/promptLabels.test.ts` fails if that strip is removed.

They surface in two places:

- `promptStart.label` — the label of the `llm()` call itself.
- `promptCompletion.messages[i].label` — the label of each message in the request payload.

One `llm(label: "x")` call tags more than one message by design: its prompt, plus the assistant message of every tool-loop round. Note `promptCompletion` logs the *request*, so the assistant reply of that same round appears in the next round's dump, not its own.

Storage lives on `MessageThread` (see `docs/dev/threads.md`); a thread rewrite via `setMessages` (summarization, repair) drops labels.
- **`promptCancelled(threadId)`** — terminator for a promptStart whose call was cancelled: a race loser's abort, Esc-cancel, or a timeout. Deliberately not an error event — a cancel is a normal outcome, and without this terminator every healthy `race()` would leave its losers' starts unpaired.

### Thread-end hooks
- **`threadEndHooksStart(threadId, eagerSummarize, messageCount)`** / **`threadEndHooksEnd(threadId, timeTaken)`** — bracket `Runner.thread`'s onThreadEnd hook invocation, inside a `threadEndHooks` span. Hook-initiated LLM calls (the eager thread summarizer) nest under that span, so the log answers WHY a call ran. The end event posts from a finally, so a throwing hook is still bracketed.

### Tool execution
- **`toolCall(toolName, args, output, model, timeTaken)`** — logs each tool invocation with its arguments, output, and timing

### Edge transitions
- **`followEdge(fromNodeId, toNodeId, isConditionalEdge, data)`** — logs when the graph follows an edge, noting whether it was a conditional edge

### Abort salvage (saveDraft)
- **`abortSalvage({action, scopeName, spanId, functionArgs, partial})`** — one event per hop where an abort's travel touches a saveDraft partial: `carried` (a frame attached its draft), `erased` (a frame dropped a callee's partial by having none of its own), `droppedAtArgPosition` / `clearedAtFork` (a partial discarded at a boundary), and `delivered` (the guard salvaged it). Emitted from inside `AbortedResult`'s methods (`lib/runtime/abortedResult.ts`), never by callers. The hops nest in an `abortUnwind` span, opened lazily by the first hop that touches a partial — an abort through undrafted code emits nothing. `spanId` is carried explicitly in the event because an abort can cross span contexts (out of a fork branch), where current-span attribution alone would split the trail. `functionArgs`/`partial` are previews truncated at 500 chars. See `docs/dev/saveDraft.md`.

### Other
- **`debug(message, data)`** — generic debug logging
- **`diff(itemA, itemB, message)`** — logs a comparison between two items

## Integration points

### RuntimeContext
Each `RuntimeContext` (`lib/runtime/state/context.ts`) holds a single `StatelogClient` instance. This ensures all events during one execution share the same `traceId`. When `createExecutionContext()` creates a child context, it gets a fresh `StatelogClient` with a new `traceId`.

### SimpleMachine
The graph execution engine (`lib/simplemachine/graph.ts`) calls statelog methods at each phase of execution: graph structure logging, node entry/exit, hook timing, and edge transitions.

### Runtime prompt
`lib/runtime/prompt.ts` logs LLM calls via `promptCompletion()` after each `smoltalk.text()` call, and tool executions via `toolCall()`.

### CLI commands
- **`lib/cli/upload.ts`** — uses `statelogClient.upload()` to send Agency source files to the Statelog server
- **`lib/cli/remoteRun.ts`** — uses `statelogClient.remoteRun()` to execute Agency programs remotely on the Statelog server

## Factory function

`getStatelogClient(config)` creates a `StatelogClient` from a `StatelogConfig` object. Used in CLI commands to create instances from `AgencyConfig.log`.

## Key behaviors

- **Graceful no-op**: if `host` is not set, all logging methods return immediately without error. This means Statelog is entirely opt-in.
- **Stdout mode**: setting `host: "stdout"` prints JSON logs to the console, useful for local debugging.
- **Non-blocking**: log calls are fire-and-forget HTTP posts; they don't block graph execution.
