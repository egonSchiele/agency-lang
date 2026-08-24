# SimpleMachine

## Overview

SimpleMachine (`lib/simplemachine/`) is the graph execution engine that runs compiled Agency programs. It's a generic state machine framework where nodes are async functions and transitions between nodes are defined by edges. When Agency code is compiled to TypeScript, the generated code registers graph nodes and edges on a `SimpleMachine` instance, which then executes the graph.

## Core concepts

### Nodes

A node is a named async function that receives data and returns either transformed data or a `GoToNode` instruction:

```typescript
graph.node("greet", async (data) => {
  // process data
  return data; // continue to next node via edge
});
```

Node functions have the signature `(data: T) => Promise<T | GoToNode<T>>`.

### Edges

Edges define transitions between nodes. There are two types:

**Regular edges** connect one node to the next in a linear sequence:
```typescript
graph.edge("greet", "farewell"); // after "greet", go to "farewell"
```

**Conditional edges** allow a node to choose from multiple targets:
```typescript
graph.conditionalEdge("router", ["handleA", "handleB"], async (data) => {
  return data.choice === "A" ? "handleA" : "handleB";
});
```

A node can have at most one edge, either regular or conditional. Registering a second edge for the same node throws a `SimpleMachineError`. If a node has no edge, the graph terminates after that node runs.

### GoToNode

A node function can return a `GoToNode` to explicitly jump to another node instead of following its edge. The target must be listed in the `adjacentNodes` of the node's conditional edge, otherwise `run` throws. A node with no edge at all terminates the graph, so its `GoToNode` is ignored:

```typescript
import { goToNode } from "./simplemachine";

graph.node("router", async (data) => {
  return goToNode("handleA", data);
});
```

## Execution flow

`graph.run(startId, input, options)` is the main entry point:

1. Start at the node identified by `startId`
2. Run the `beforeNode` hook (if configured)
3. Execute the node function
4. Run the `afterNode` hook (if configured)
5. If the node returned a `GoToNode`, check the target against the node's conditional edge and jump to it
6. Otherwise, follow the node's edge to determine the next node
7. If there's no edge, the graph terminates and returns the final data
8. Repeat from step 2 with the next node

The `options` parameter takes an `onNodeEnter` callback and a `statelogClient`. The runtime passes `onNodeEnter` to track `nodesTraversed` on the `StateStack` for interrupt resumption. A `statelogClient` passed here overrides the one the machine built from its own config.

## Validation

SimpleMachine supports optional output validation with retries. After a node runs, `runAndValidate` passes its output to the configured validation function. If validation fails, it re-runs the node up to `maxRetries` times, then throws a `SimpleMachineError`.

```typescript
const config: SimpleMachineConfig<T> = {
  validation: {
    func: async (data) => { /* return true/false */ },
    maxRetries: 3,
  },
};
```

## Hooks

Two lifecycle hooks can be configured:

- `beforeNode(nodeId, data)` — runs before each node, can modify data
- `afterNode(nodeId, data)` — runs after each node, can modify data

The runtime uses these for lifecycle callbacks. See `docs/misc/lifecycleHooks.md`.

## Statelog integration

SimpleMachine integrates with `StatelogClient` for tracing. During execution, it logs:
- Graph structure (nodes, edges, start node) at the beginning
- Node entry and exit with execution time
- Hook execution with timing
- Edge transitions (including whether the edge was conditional)

See `docs/dev/hosting/statelog.md` for more on the tracing system.

## Visualization

SimpleMachine provides two methods for inspecting graph structure:

- `prettyPrint()` — prints the graph to the console with colored output
- `toMermaid()` — generates a Mermaid diagram string for the graph

Nothing in the repo calls either one right now. They are debugging aids you can reach for from a REPL or a scratch script.

## How Agency uses SimpleMachine

When Agency code is compiled, the generated TypeScript:

1. Creates a `SimpleMachine` instance stored on the runtime context as `__globalCtx.graph`. `RuntimeContext` builds it in its constructor (`lib/runtime/state/context.ts`) and wires the statelog config into it.
2. Registers each Agency graph node via `graph.node(id, asyncFn)`
3. Registers edges between nodes via `graph.edge()` or `graph.conditionalEdge()`
4. Calls `graph.run(startNodeId, initialData, options)` to execute the program. The runtime does this from `runNode` in `lib/runtime/node.ts`, and again from the interrupt-resume and rewind paths.

The `merge()` method combines two `SimpleMachine` instances. An Agency program that imports nodes from other files merges each file's graph into the main graph. `merge()` throws if the two machines declare the same node or the same edge source.

## Key files

- `lib/simplemachine/graph.ts` — `SimpleMachine` class and `GoToNode`/`goToNode`
- `lib/simplemachine/types.ts` — Type definitions (`SimpleMachineConfig`, `Edge`, `ConditionalEdge`, etc.) and edge factory functions
- `lib/simplemachine/error.ts` — `SimpleMachineError` custom error class
- `lib/simplemachine/util.ts` — `runtime()` helper for measuring execution time
- `lib/simplemachine/index.ts` — re-exports the other three modules
