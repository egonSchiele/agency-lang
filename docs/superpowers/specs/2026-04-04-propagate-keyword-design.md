# Propagate Keyword Design

## Problem

When an interrupt is wrapped in an `approve` handler, it gets auto-approved without user interaction. Currently, the only way to override this is with a `reject` handler, which blanket-rejects the interrupt. There is no way to say "I don't want to auto-approve or auto-reject — I want the user to decide."

## Solution

Introduce a `propagate` keyword that forces an interrupt to propagate to the user for manual response, overriding any approvals in the handler chain.

## Priority Hierarchy

The handler chain evaluates all handlers (unless a rejection short-circuits). The final decision follows this priority:

1. **Reject** — highest priority, short-circuits the chain immediately
2. **Propagate** — overrides approvals, forces user interaction
3. **Approve** — only takes effect if nothing rejects or propagates
4. **Passthrough** (`undefined`) — no opinion; if all handlers pass through, defaults to propagation

## Syntax

`propagate` takes no arguments. It is a signal that says "send this interrupt to the user." The original interrupt data is preserved unchanged.

### As a built-in function reference

```
handle {
  handle {
    result = interrupt("Need approval")
  } with approve
} with propagate
```

### As an inline return value

```
handle {
  result = interrupt("Need approval")
} with (data) {
  if data.risk == "high" {
    return propagate()
  }
  return approve()
}
```

## Handler Chain Evaluation

The `interruptWithHandlers` function iterates handlers in reverse order (outermost first). The updated logic:

- **Reject** — stop immediately, return rejection. No further handlers consulted.
- **Propagate** — record that propagation was requested. Continue evaluating remaining handlers (a later handler may still reject).
- **Approve** — record approval. Continue evaluating.
- **Passthrough** (`undefined`) — continue evaluating.

After all handlers are evaluated:
- If any handler rejected: already returned (short-circuited).
- If any handler propagated: return `interrupt(data)` with the original data.
- If any handler approved: return `{ type: "approved", value: approvedValue }`.
- If all handlers passed through: return `interrupt(data)` (default behavior).

If multiple handlers approve, the innermost approval value is used (but any propagate overrides all approvals).

When the interrupt is propagated and the user responds (approve/reject/modify/resolve), the response bypasses the handler chain entirely and goes straight to the interrupt site. A propagated interrupt is identical to an unhandled interrupt once it reaches the user — both return `interrupt(data)`. The difference is purely in how they override other handlers in the chain.

## Runtime Types

### New type in `lib/runtime/types.ts`

```typescript
export type Propagated = { type: "propagated" };
```

No `value` field — `propagate` does not modify interrupt data.

### Updated `HandlerFn`

```typescript
export type HandlerFn = (data: any) => Promise<Approved | Rejected | Propagated | undefined>;
```

### New factory function in generated imports

```typescript
function propagate() { return { type: "propagated" as const }; }
```

## Parser

No parser changes are needed. The `functionRefHandlerParser` in `lib/parsers/function.ts` accepts any identifier as a handler function name. `propagate` will be parsed as a function reference just like `approve` and `reject` are today.

## Updated `interruptWithHandlers`

```typescript
export async function interruptWithHandlers<T = any>(
  data: T,
  ctx: RuntimeContext<any>,
): Promise<Interrupt<T> | Approved | Rejected> {
  if (ctx.handlers.length === 0) {
    return interrupt(data);
  }
  let approvedValue: any = undefined;
  let hasApproval = false;
  let hasPropagation = false;

  for (let i = ctx.handlers.length - 1; i >= 0; i--) {
    const result = await ctx.handlers[i](data);
    if (result === undefined) {
      await ctx.audit({
        type: "handlerResult",
        handlerIndex: i,
        data,
        result: "passthrough",
      });
      continue;
    }
    if (result.type === "rejected") {
      await ctx.audit({
        type: "handlerResult",
        handlerIndex: i,
        data,
        result: "rejected",
        value: result.value,
      });
      await ctx.audit({
        type: "handlerDecision",
        data,
        decision: "rejected",
        value: result.value,
      });
      return { type: "rejected", value: result.value };
    }
    if (result.type === "propagated") {
      await ctx.audit({
        type: "handlerResult",
        handlerIndex: i,
        data,
        result: "propagated",
      });
      hasPropagation = true;
      continue;
    }
    if (result.type === "approved") {
      await ctx.audit({
        type: "handlerResult",
        handlerIndex: i,
        data,
        result: "approved",
        value: result.value,
      });
      hasApproval = true;
      approvedValue = result.value;
      continue;
    }
    throw new Error(
      `Handler returned invalid result type: ${JSON.stringify(result)}. Expected "approved", "rejected", "propagated", or undefined.`,
    );
  }

  if (hasPropagation) {
    await ctx.audit({ type: "handlerDecision", data, decision: "propagated" });
    return interrupt(data);
  }
  if (hasApproval) {
    await ctx.audit({
      type: "handlerDecision",
      data,
      decision: "approved",
      value: approvedValue,
    });
    return { type: "approved", value: approvedValue };
  }
  await ctx.audit({ type: "handlerDecision", data, decision: "unhandled" });
  return interrupt(data);
}
```

## Builder Changes

In `lib/backends/typescriptBuilder.ts`, the `processHandleBlockWithSteps` method adds `propagate` as a built-in handler name. The existing check at line 2173:

```typescript
if (fnName === "approve" || fnName === "reject") {
```

Gets a new branch for `propagate`:

```typescript
if (fnName === "approve" || fnName === "reject") {
  // approve(__data) / reject(__data) — pass interrupt data as value
  handler = ts.constDecl(handlerName, ts.arrowFn(
    [{ name: "__data", typeAnnotation: "any" }],
    ts.call(ts.id(fnName), [ts.id("__data")]),
    { async: true },
  ));
} else if (fnName === "propagate") {
  // propagate() — no arguments, just signals propagation
  handler = ts.constDecl(handlerName, ts.arrowFn(
    [{ name: "__data", typeAnnotation: "any" }],
    ts.call(ts.id(fnName), []),
    { async: true },
  ));
} else {
  // ... existing function ref handler logic
}
```

## Audit Logging Changes

### `HandlerResultAudit`

The `result` field gains `"propagated"`:

```typescript
export type HandlerResultAudit = AuditBase & {
  type: "handlerResult";
  handlerIndex: number;
  data: unknown;
  result: "approved" | "rejected" | "passthrough" | "propagated";
  value?: unknown;
};
```

### `HandlerDecisionAudit`

The `decision` field gains `"propagated"`:

```typescript
export type HandlerDecisionAudit = AuditBase & {
  type: "handlerDecision";
  data: unknown;
  decision: "approved" | "rejected" | "unhandled" | "propagated";
  value?: unknown;
};
```

## Generated Imports

In `lib/templates/backends/typescriptGenerator/imports.mustache`, add `propagate` alongside the existing `approve` and `reject` builtins:

```typescript
function approve(value?: any) { return { type: "approved" as const, value }; }
function reject(value?: any) { return { type: "rejected" as const, value }; }
function propagate() { return { type: "propagated" as const }; }
```

## Tests

New test fixtures in `tests/agency/handlers/`:

1. **`handle-propagate-basic`** — `handle { ... } with propagate` causes the interrupt to reach the user
2. **`handle-propagate-overrides-approve`** — inner approve + outer propagate = interrupt propagated to user
3. **`handle-propagate-rejected-by-reject`** — inner propagate + outer reject = rejected (reject wins)
4. **`handle-propagate-inline`** — inline handler returning `propagate()`
5. **`handle-propagate-multiple`** — multiple propagates in chain, result is original data propagated to user
6. **`handle-propagate-with-approve-and-passthrough`** — mix of all four handler results to verify priority
7. **`handle-inner-propagate-outer-approve`** — inner propagate + outer approve = interrupt propagated (propagate wins regardless of position)

## Files Changed

- `lib/runtime/types.ts` — add `Propagated` type, update `HandlerFn`
- `lib/runtime/interrupts.ts` — update `interruptWithHandlers`
- `lib/runtime/audit.ts` — update `HandlerResultAudit` and `HandlerDecisionAudit`
- `lib/backends/typescriptBuilder.ts` — add `propagate` to built-in handler check
- `lib/templates/backends/typescriptGenerator/imports.mustache` — add `propagate` factory function
- `DOCS.md` — document `propagate` in the interrupt handlers section
- `tests/agency/handlers/` — 7 new test fixtures
