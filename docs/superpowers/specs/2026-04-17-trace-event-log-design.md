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

`TraceReader.fromFile()` already handles both `.agencytrace` and `.agencybundle` files transparently, so the CLI code needs no special-casing.

**CLI structure change:** The existing `trace` command is currently a leaf command (runs a trace). It needs to be converted to a command group: `trace run` becomes the default subcommand (preserving existing behavior), and `trace log` is added alongside it.

**Edge cases:**
- Empty traces (header only, or header + footer with no checkpoints): output an empty JSON array `[]`.
- Crashed/truncated traces (no footer): process whatever checkpoints exist. The output may be partial -- this is expected and no warning is needed since `TraceReader` already handles this gracefully.

## Output Format

A single JSON array written to stdout (or a file with `-o`). Each element is a structured event object.

```json
[
  { "step": 0, "nodeId": "main", "scopeName": "main", "moduleId": "foo.agency", "stepPath": "0", "type": "node-enter", "nodeName": "main" },
  { "step": 1, "nodeId": "main", "scopeName": "main", "moduleId": "foo.agency", "stepPath": "1", "type": "variable-set", "variable": "name", "value": "world", "previousValue": null, "scope": "local" },
  { "step": 2, "nodeId": "main", "scopeName": "main", "moduleId": "foo.agency", "stepPath": "2", "type": "llm-call", "prompt": "Say hello to world!", "response": "Hello, world!", "toolCalls": [], "tokenUsage": { "inputTokens": 12, "outputTokens": 5, "cachedInputTokens": 0, "totalTokens": 17 } },
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
| `llm-call` | Message history grew (new assistant message) | `prompt`, `response`, `toolCalls`, `tokenUsage` |
| `tool-call` | LLM-initiated tool call messages appeared in thread | `toolName`, `args`, `result` |
| `interrupt-thrown` | Checkpoint label is an interrupt-related label | `message` |
| `interrupt-resolved` | Execution resumed after interrupt checkpoint | `outcome: "approved" \| "rejected" \| "resolved"`, `data` (optional, arbitrary resolution data) |
| `branch` | Internal variables (`__condbranch_*`, `__iteration_*`) changed | `condition: "if" \| "else" \| "while" \| "for"`, `iteration` |

### Clarification: `tool-call` vs `function-enter`/`function-exit`

In Agency, tools and functions are the same thing. The `function-enter`/`function-exit` events are emitted for all function calls detected via stack frame changes. The `tool-call` event is emitted specifically for LLM-initiated tool invocations, detected from tool_call/tool_result messages in the thread history. A single tool invocation will produce both a `tool-call` event (from message history) and `function-enter`/`function-exit` events (from stack changes). The `tool-call` event provides the LLM's perspective (what it asked for and got back), while `function-enter`/`function-exit` provide the execution perspective (what actually ran).

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

4. **LLM calls** -- compare message history using raw `MessageJSON` objects from the thread store in the checkpoint's serialized state (not `getThreadMessages()`, which flattens tool calls to strings). If new messages appeared:
   - New user message is the prompt.
   - New assistant message is the response.
   - Tool_call/tool_result message pairs in between produce `tool-call` events emitted before the `llm-call` event.
   - Diff cumulative token stats in globals (`inputTokens`, `outputTokens`, `cachedInputTokens`, `totalTokens`) to approximate per-call usage. Note: when multiple LLM calls occur in a single checkpoint step, per-call attribution is approximate.

5. **Interrupts** -- detect using checkpoint labels. Known interrupt-related labels include `"result-entry"` (`RESULT_ENTRY_LABEL`). If a checkpoint has an interrupt-related label, emit `interrupt-thrown`. If the next checkpoint shows execution continuing past the interrupt point (step path advances beyond the interrupt), emit `interrupt-resolved`. The `outcome` field is `"approved"`, `"rejected"`, or `"resolved"` (for interrupts resolved with arbitrary data). The optional `data` field contains any resolution data.

6. **Control flow** -- detect branch type using internal checkpoint variables: `__condbranch_*` variables indicate if/else branches, `__iteration_*` variables indicate loop iterations. Step path patterns provide supplementary signal (repeated sub-paths for loops, skipped paths for untaken branches).

### Ordering within a step

When a single checkpoint transition produces multiple events, they are emitted in the order above (node → stack → variables → llm → interrupts → control flow). This matches the logical execution order.

## Scope

### In scope
- Single-threaded execution (main stack)
- All event types listed above

### Out of scope for v1
- **Fork/parallel execution.** When `fork` blocks produce checkpoints with branch state (`branches` field on `State`), each branch has its own stack and thread store. Handling branch diffs would require emitting events per branch with a `branchId` field. This is deferred to a future version.

## Implementation

| File | Purpose |
|------|---------|
| `lib/runtime/trace/eventLog.ts` | Core diffing logic: `deriveEvents()`, individual detectors, event types |
| `lib/cli/events.ts` | CLI command: reads trace/bundle, runs event log, writes output |
| `scripts/agency.ts` | Convert `trace` to command group, add `trace log` subcommand |

## Design decisions

- **Pure diffing, no trace format changes.** Works with existing traces. If specific gaps emerge later (e.g., interrupt outcomes are ambiguous), the trace format can be enriched then.
- **JSON array output.** Single array rather than JSONL, for easier programmatic consumption.
- **No source locations.** Events include logical info (node name, scope, step path) but not file/line numbers. Keeps things simple and doesn't require source files.
- **Full LLM data inline.** Prompts, responses, tool call args/results, and token usage are all included. No summary/verbose split.
- **Internal variables filtered.** Variables prefixed with `__` are skipped to avoid noise from framework internals.
- **Token usage field names match runtime.** Uses `inputTokens`/`outputTokens`/`cachedInputTokens`/`totalTokens` as stored in `GlobalStore`, not OpenAI-style field names.
