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

A node can have at most one edge (regular or conditional). If a node has no edge, the graph terminates after that node runs.

### GoToNode

A node function can return a `GoToNode` to explicitly jump to another node, bypassing the edge system. The target must be one of the adjacent nodes in a conditional edge:

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
5. If the node returned a `GoToNode`, jump to that node
6. Otherwise, follow the node's edge (regular or conditional) to determine the next node
7. If there's no edge and no `GoToNode`, the graph terminates and returns the final data
8. Repeat from step 2 with the next node

The `options` parameter supports an `onNodeEnter` callback, which the runtime uses to track `nodesTraversed` on the `StateStack` for interrupt resumption.

## Validation

SimpleMachine supports optional output validation with retries. When configured, after a node runs, the output is passed to a validation function. If validation fails, the node is re-executed up to `maxRetries` times.

```typescript
const config: SimpleMachineConfig<T> = {
  validation: {
    validate: async (data) => { /* return true/false */ },
    maxRetries: 3,
  },
};
```

## Hooks

Two lifecycle hooks can be configured:

- `beforeNode(nodeId, data)` — runs before each node, can modify data
- `afterNode(nodeId, data)` — runs after each node, can modify data

These are used by the runtime for lifecycle callbacks (see `docs/lifecycleHooks.md`).

## Statelog integration

SimpleMachine integrates with `StatelogClient` for tracing. During execution, it logs:
- Graph structure (nodes, edges, start node) at the beginning
- Node entry and exit with execution time
- Hook execution with timing
- Edge transitions (including whether the edge was conditional)

See `docs/dev/statelog.md` for more on the tracing system.

## Visualization

SimpleMachine provides two methods for inspecting graph structure:

- `prettyPrint()` — prints the graph to the console with colored output
- `toMermaid()` — generates a Mermaid diagram string for the graph

The CLI `graph` command uses `toMermaid()` to visualize compiled Agency programs.

## How Agency uses SimpleMachine

When Agency code is compiled, the generated TypeScript:

1. Creates a `SimpleMachine` instance stored on the `RuntimeContext` as `__globalCtx.graph`
2. Registers each Agency graph node via `graph.node(id, asyncFn)`
3. Registers edges between nodes via `graph.edge()` or `graph.conditionalEdge()`
4. Calls `graph.run(startNodeId, initialData)` to execute the program

The `merge()` method allows combining multiple `SimpleMachine` instances, which is used when an Agency program imports nodes from other files — each file's graph is merged into the main graph.

## Key files

- `lib/simplemachine/graph.ts` — `SimpleMachine` class and `GoToNode`/`goToNode`
- `lib/simplemachine/types.ts` — Type definitions (`SimpleMachineConfig`, `Edge`, `ConditionalEdge`, etc.) and edge factory functions
- `lib/simplemachine/error.ts` — `SimpleMachineError` custom error class
- `lib/simplemachine/util.ts` — `runtime()` helper for measuring execution time
