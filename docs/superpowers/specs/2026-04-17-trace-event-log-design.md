# Trace Event Log Design

## Summary

Derive a structured JSON event log from an existing Agency trace file (or bundle) by diffing consecutive checkpoints. No changes to the trace format or runtime instrumentation are required -- all events are reconstructed post-hoc from the checkpoint data that traces already capture.

## Motivation

Traces capture a complete checkpoint at every step of execution, containing the full call stack, globals, message history, and location info. By comparing consecutive checkpoints, we can reconstruct a complete event log of what happened during execution. This gives users a structured, programmatically consumable view of agent behavior without needing to emit logs at runtime.

## CLI Interface

```bash
agency trace log <file>            # accepts .agencytrace or .agencybundle, outputs to stdout
agency trace log <file> -o out.json  # write to file
```

If given a `.agencybundle`, the trace is extracted from the bundle. If given a raw `.agencytrace`, the trace is read directly. Source files are not required.

## Output Format

A single JSON array written to stdout (or a file with `-o`). Each element is a structured event object.

```json
[
  { "step": 0, "nodeId": "main", "scopeName": "main", "moduleId": "foo.agency", "stepPath": "0", "type": "node-enter", "nodeName": "main" },
  { "step": 1, "nodeId": "main", "scopeName": "main", "moduleId": "foo.agency", "stepPath": "1", "type": "variable-set", "variable": "name", "value": "world", "previousValue": null, "scope": "local" },
  { "step": 2, "nodeId": "main", "scopeName": "main", "moduleId": "foo.agency", "stepPath": "2", "type": "llm-call", "prompt": "Say hello to world!", "response": "Hello, world!", "toolCalls": [], "tokenUsage": { "promptTokens": 12, "completionTokens": 5, "totalTokens": 17 } },
  { "step": 3, "nodeId": "main", "scopeName": "main", "moduleId": "foo.agency", "stepPath": "3", "type": "variable-set", "variable": "greeting", "value": "Hello, world!", "previousValue": null, "scope": "local" }
]
```

## Event Types

Every event shares a common shape:

```typescript
type TraceEvent = {
  step: number           // checkpoint index (0-based)
  nodeId: string         // current graph node
  scopeName: string      // current scope (function/node name)
  moduleId: string       // current module
  stepPath: string       // hierarchical step counter
  type: string           // discriminant
  // ... type-specific fields
}
```

### Event type catalog

| Type | Derived from | Key fields |
|------|-------------|------------|
| `node-enter` | `nodeId` changed | `nodeName` |
| `node-exit` | `nodeId` changed (previous checkpoint) | `nodeName` |
| `function-enter` | New stack frame appeared | `functionName`, `args` |
| `function-exit` | Stack frame removed | `functionName`, `returnValue` |
| `variable-set` | Local or global value changed | `variable`, `value`, `previousValue`, `scope: "local" \| "global"` |
| `llm-call` | Message history grew | `prompt`, `response`, `toolCalls`, `tokenUsage` |
| `tool-call` | Tool call/result messages appeared | `toolName`, `args`, `result` |
| `interrupt-thrown` | Checkpoint label or state indicates interrupt | `message` |
| `interrupt-resolved` | Execution resumed after interrupt checkpoint | `outcome: "approved" \| "rejected"` |
| `branch` | `stepPath` diverges from linear increment | `condition: "if" \| "else" \| "while" \| "for"`, `iteration` |

## Diffing Algorithm

The core logic walks the checkpoint array and compares each pair:

```
for i in 1..checkpoints.length:
  prev = checkpoints[i-1]
  curr = checkpoints[i]
  events.push(...deriveEvents(prev, curr))
```

The first checkpoint (index 0) produces an initial `node-enter` event.

### `deriveEvents(prev, curr)` runs these detectors in order:

1. **Node transitions** -- compare `prev.nodeId` vs `curr.nodeId`. If different, emit `node-exit` for prev, `node-enter` for curr.

2. **Stack frame changes** -- compare stack depths and frame identities (by `scopeName` + `moduleId`).
   - New frame at top: `function-enter`, extract args from the new frame's locals.
   - Frame removed from top: `function-exit`, look at the now-top frame's locals for a new variable (the return value assignment).
   - Multiple frames added/removed in one step: emit events for each.

3. **Variable changes** -- for each stack frame that exists in both checkpoints, diff local variables (key-value comparison). For globals, diff each module's global store. Emit `variable-set` for each changed or new variable. Skip internal/framework variables (those starting with `__`).

4. **LLM calls** -- compare message history from `checkpoint.getThreadMessages()`. If new messages appeared:
   - New user message is the prompt.
   - New assistant message is the response.
   - Tool_call/tool_result message pairs in between produce `tool-call` events emitted before the `llm-call` event.
   - Diff token stats in globals to get usage for this specific call.

5. **Interrupts** -- if a checkpoint's label contains interrupt-related markers, or if execution jumped backward (step path regression after an interrupt), emit `interrupt-thrown`. If the next checkpoint shows execution continuing past the interrupt point, emit `interrupt-resolved` with the outcome.

6. **Control flow** -- parse `stepPath` (e.g., `"1.3.2"`) to detect branching. If the step path diverges from a linear increment, infer the branch type from the pattern. Loop iterations show as repeated scope entries with incrementing sub-paths.

### Ordering within a step

When a single checkpoint transition produces multiple events, they are emitted in the order above (node → stack → variables → llm → interrupts → control flow). This matches the logical execution order.

## Implementation

| File | Purpose |
|------|---------|
| `lib/runtime/trace/eventLog.ts` | Core diffing logic: `deriveEvents()`, individual detectors, event types |
| `lib/cli/events.ts` | CLI command: reads trace/bundle, runs event log, writes output |
| `scripts/agency.ts` | Wire up `agency trace log` subcommand |

## Design decisions

- **Pure diffing, no trace format changes.** Works with existing traces. If specific gaps emerge later (e.g., interrupt outcomes are ambiguous), the trace format can be enriched then.
- **JSON array output.** Single array rather than JSONL, for easier programmatic consumption.
- **No source locations.** Events include logical info (node name, scope, step path) but not file/line numbers. Keeps things simple and doesn't require source files.
- **Full LLM data inline.** Prompts, responses, tool call args/results, and token usage are all included. No summary/verbose split.
- **Internal variables filtered.** Variables prefixed with `__` are skipped to avoid noise from framework internals.
