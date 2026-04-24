# `goto` Keyword for Node Transitions

## Problem

Agency models agents as graphs where nodes transition to other nodes. Currently, node transitions use `return nodeCall()`:

```
node main() {
  return categorize(message)
}
```

This is misleading because `return` implies the node call returns a value to the caller, but node transitions are permanent — execution never comes back. The `return` keyword is overloaded: it means "return a value" for functions but "transition permanently" for node calls.

## Solution

Add a `goto` keyword that makes the state-machine semantics explicit:

```
node main() {
  goto categorize(message)
}
```

`return nodeCall()` continues to work as an alias for backward compatibility.

## Design

### 1. AST Node

New AST node type `GotoStatement`:

```typescript
type GotoStatement = BaseNode & {
  type: "gotoStatement";
  nodeCall: FunctionCall;
};
```

Add to the `AgencyNode` union in `lib/types.ts`.

### 2. Parser

Add a `gotoStatementParser` in `lib/parsers/` that matches `goto <functionCall>`. The parser captures the function call and produces a `GotoStatement` AST node. Wire it into the statement-level parser alternatives in `lib/parser.ts`.

`goto` must be followed by a function call (not a bare expression). `goto 5` or `goto someVar` are parse errors.

### 3. Type Checker

Validate:
- `goto` is only used inside node bodies, not inside functions. Error: `"goto can only be used inside a node body"`
- The target is a known node, not a function. Error: `"goto target must be a node, not a function"`

### 4. Builder

Add a `case "gotoStatement"` to the `processNode` switch. `processGotoStatement` calls `generateNodeCallExpression()` on the function call and returns the result — the same code path used when `processReturnStatement` detects a node call inside a return. `goto` works inside nested control flow (`if`, `while`, `for`, `match`) within a node body, same as `return nodeCall()` does today.

Also update the error message in `processGraphNode`'s body scan (which warns about bare unreturned node calls) to mention `goto` as an alternative to `return`.

### 5. Backward Compatibility

`return nodeCall()` continues to work identically. No changes to the existing return statement handling.

### 6. What Doesn't Change

- **Runtime** — no changes. The generated code is identical (`goToNode()`).
- **SimpleMachine** — no changes. Graph execution is unchanged.
- **Graph edge tracking** — `currentAdjacentNodes` tracking in the builder needs to also be triggered by `goto` statements, same as it is for `return nodeCall()`.
- **Preprocessor** — may need a `gotoStatement` case if it explicitly walks AST node types. Check during implementation.
