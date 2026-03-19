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
- **`promptCompletion(messages, completion, model, timeTaken, tools, responseFormat)`** — logs the full message history, model response, model name, tools provided, and response format

### Tool execution
- **`toolCall(toolName, args, output, model, timeTaken)`** — logs each tool invocation with its arguments, output, and timing

### Edge transitions
- **`followEdge(fromNodeId, toNodeId, isConditionalEdge, data)`** — logs when the graph follows an edge, noting whether it was a conditional edge

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
