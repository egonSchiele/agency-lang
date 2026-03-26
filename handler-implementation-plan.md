# Handle/With Blocks — Implementation Plan

## Background & Design Rationale

Agency is a DSL that compiles to TypeScript for building AI agent workflows. A core feature is **interrupts** — the ability to pause execution, return control to the caller, and resume later. Currently, interrupts always propagate to the TypeScript caller, who must handle them with `approveInterrupt`/`rejectInterrupt`.

**The problem:** Agents often need access to real tools (email, files, APIs) but those tools can be dangerous. The current interrupt system lets you add approval gates, but only at the TypeScript level. There's no way to write in-language policies that automatically approve safe actions and reject dangerous ones.

**The solution:** `handle...with` blocks — an in-language mechanism to intercept interrupts. Inspired by algebraic effect handlers from PL theory (Koka, Eff, OCaml 5), but built on top of Agency's existing interrupt infrastructure.

### Key design decisions (all discussed and agreed upon with the user)

1. **Handlers are callbacks on RuntimeContext, consulted synchronously at the interrupt point.** No checkpoint/restore needed for the basic approve/reject case. The handler runs at the point `interrupt()` is called, decides, and `interrupt()` returns — the interrupted function never left the call stack.

2. **`approve` and `reject` are value expressions used with `return`.** Both can carry optional values: `return approve "yes"`, `return reject "reason"`.

3. **Nested handlers: ALL must approve.** Interrupts propagate inner-to-outer on approval. Any rejection is final and immediate. This makes security additive — you can't bypass an outer guard by wrapping a more permissive inner handler.

4. **Rejection halts the function containing the interrupt, NOT the entire handle block.** If `foo()` is rejected, it returns early (undefined). The calling function `bar()` continues. This matches exception semantics developers already understand.

5. **No checkpointing on rejection.** Early return only — what's done is done. Users can explicitly use `checkpoint()`/`restore()` if they want rollback.

6. **TypeScript boundary is different.** If a handler in Agency approves, the interrupt does NOT reach TypeScript. TypeScript is the fallback for unhandled interrupts only. This preserves current behavior while letting handlers fully resolve things in-language.

7. **Handlers are NOT interruptible.** No interrupts inside handler bodies. Handlers run to completion and return a decision.

8. **`with functionName` is special syntax, not first-class functions.** The builder resolves the function at compile time and generates a wrapper. No general higher-order function support needed.

9. **Tool call rejections send a message back to the LLM.** Custom rejection strings become the tool message (e.g., `reject "Not allowed to email external addresses"`). The LLM sees this and can adjust its approach.

10. **For v2: enforce return type of handler functions.** The type checker should verify that functions used with `with` always return `approve` or `reject`.

---

## Syntax

```agency
// Inline handler
handle {
  foo()
} with (data) {
  if (data.type == "safe") {
    return approve
  }
  return reject "not allowed"
}

// Function reference handler
def myPolicy(data) {
  if (data.type == "sendEmail") {
    return approve
  }
  return reject "unknown action"
}

handle {
  agent()
} with myPolicy

// Nested handlers — outer overrides inner
handle {
  handle {
    foo()
  } with (data) {
    return approve    // inner approves
  }
} with (data) {
  return reject       // outer rejects — rejection wins
}

// Approve/reject with values
handle {
  result = foo()
} with (data) {
  return approve "yes"     // approved value assigned to result
  return reject "reason"   // custom rejection message
}
```

---

## How It Works (Runtime Mechanism)

### Handler registration
```
handle { body } with handler
```
compiles to:
```ts
const __handler = async (__data) => { /* compiled handler body */ };
__ctx.pushHandler(__handler);
try {
  /* compiled handle body with substep tracking */
} finally {
  __ctx.popHandler();
}
```

### Interrupt consultation
When `interrupt(data)` is called anywhere in the call chain:
1. Check `__ctx.handlers.length > 0`
2. Walk handlers inner-to-outer (last pushed = innermost)
3. Each handler returns `{ type: "approve", value? }` or `{ type: "reject", value? }`
4. If any rejects → return `{ type: "rejected", value? }`
5. If all approve → return `{ type: "approved", value? }`
6. If no handlers → return `{ type: "interrupt", data }` (current behavior)

### Generated code at interrupt call sites
```ts
const __r = await interruptWithHandlers("msg", __ctx);
if (isRejected(__r)) {
  return { data: undefined };  // halt this function
}
if (isInterrupt(__r)) {
  // no handler — propagate to TypeScript (existing behavior)
  await __ctx.pendingPromises.awaitAll();
  return __r;
}
// if approved — continue execution
// for assigned: __self.response = __r.value;
```

### Rejection trace example
```
bar() calls foo() which calls interrupt("msg")
→ interrupt() checks handlers → handler rejects
→ interrupt() returns { type: "rejected" }
→ generated code in foo() sees isRejected → returns { data: undefined }
→ bar() receives undefined (not an interrupt) → continues normally
→ bar() prints "Done"
```

### Tool call integration
In `executeToolCalls`, after `handler.execute()`:
```ts
if (isRejected(result)) {
  const msg = typeof result.value === "string" ? result.value : "Tool call rejected by policy";
  messages.push(smoltalk.toolMessage(msg, { tool_call_id, name }));
  continue;  // LLM sees rejection, can adjust
}
```

---

## Phase 1: Runtime Support

All runtime changes. Independently testable via unit tests.

### 1a. New types (`lib/runtime/types.ts`)

```ts
export type HandlerResult =
  | { type: "approve"; value?: any }
  | { type: "reject"; value?: any };

export type HandlerFn = (data: any) => Promise<HandlerResult>;

export type Rejected = { type: "rejected"; value?: any };
export type Approved = { type: "approved"; value?: any };
```

### 1b. Handler stack on RuntimeContext (`lib/runtime/state/context.ts`)

```ts
// New field
handlers: HandlerFn[] = [];

// New methods
pushHandler(fn: HandlerFn): void { this.handlers.push(fn); }
popHandler(): void { this.handlers.pop(); }
```

Initialize `handlers = []` in constructor and `createExecutionContext()`.
Add `this.handlers = null as any` in `cleanup()`.
Import `HandlerFn` from `../types.js`.

### 1c. New functions (`lib/runtime/interrupts.ts`)

```ts
export function isRejected(obj: any): obj is Rejected {
  return obj && obj.type === "rejected";
}

export function isApproved(obj: any): obj is Approved {
  return obj && obj.type === "approved";
}

export async function interruptWithHandlers<T = any>(
  data: T,
  ctx: RuntimeContext<any>,
): Promise<Interrupt<T> | Approved | Rejected> {
  if (ctx.handlers.length === 0) {
    return interrupt(data);
  }
  let approvedValue: any = undefined;
  for (let i = ctx.handlers.length - 1; i >= 0; i--) {
    const result = await ctx.handlers[i](data);
    if (result.type === "reject") {
      return { type: "rejected", value: result.value };
    }
    approvedValue = result.value;
  }
  return { type: "approved", value: approvedValue };
}
```

### 1d. Tool call integration (`lib/runtime/prompt.ts`)

In `executeToolCalls`, after `result = await handler.execute(...params)` (~line 266), BEFORE existing `isInterrupt` check (~line 340):

```ts
if (isRejected(result)) {
  const message = typeof result.value === "string"
    ? result.value : "Tool call rejected by policy";
  messages.push(smoltalk.toolMessage(message, {
    tool_call_id: toolCall.id, name: toolCall.name,
  }));
  continue;
}
```

### 1e. Exports (`lib/runtime/index.ts`)

Export: `interruptWithHandlers`, `isRejected`, `isApproved`

### 1f. Generated imports (`lib/templates/backends/typescriptGenerator/imports.mustache`)

Add `interruptWithHandlers, isRejected, isApproved` alongside `interrupt, isInterrupt` on line 13.

---

## Phase 2: AST Type + Parser

### 2a. New AST type (`lib/types/handleBlock.ts`)

```ts
import type { AgencyNode } from "../types.js";

export type HandleBlock = {
  type: "handleBlock";
  body: AgencyNode[];
  handler:
    | { kind: "inline"; paramName: string; body: AgencyNode[] }
    | { kind: "functionRef"; functionName: string };
};
```

### 2b. Wire into types (`lib/types.ts`)

- `export * from "./types/handleBlock.js"`
- Add `HandleBlock` to `AgencyNode` union

### 2c. Parser (`lib/parsers/handleBlock.ts`)

Parse two forms:
1. `handle { ...body... } with (paramName) { ...handlerBody... }`
2. `handle { ...body... } with functionName`

Use tarsec combinators following `_messageThreadParser` pattern: `str("handle")` keyword, body in `{}` with `bodyParser`, `str("with")`, then either `(param) { handlerBody }` or bare function name.

`approve` and `reject`: treat as function calls via existing `functionCallParser`. `return approve` parses as `return approve()`. `return approve "yes"` parses as `return approve("yes")`. No new AST types — the builder recognizes these function names.

### 2d. Wire parser

- `lib/parser.ts`: add to `agencyNode` `or()` list
- `lib/parsers/function.ts`: add to `bodyParser` `or()` list

### 2e. Parser tests (`lib/parsers/handleBlock.test.ts`)

---

## Phase 3: Preprocessor

### 3a. `lib/preprocessors/typescriptPreprocessor.ts`

Add `handleBlock` case at every location that branches on `ifElse`, `whileLoop`, `forLoop`, `messageThread`. There are ~12 such locations (searchable by grepping for `messageThread` or `whileLoop` in the file). For each:

- Walk into `node.body`
- Walk into `node.handler.body` if `handler.kind === "inline"`

**Important:** the handler body should NOT be flagged as containing interrupts. Only the handle body should be checked for interrupts/async.

### 3b. Walk utilities (`lib/utils/node.ts`)

Add `handleBlock` case to `walkNodes` and `getAllVariablesInBody`.

---

## Phase 4: Code Generation (Builder + IR + Templates)

### 4a. IR type (`lib/ir/tsIR.ts`)

```ts
export type TsHandleSteps = {
  kind: "handleSteps";
  subStepPath: number[];
  handler: TsNode;      // handler arrow function declaration
  body: TsNode[];       // body statements with substep guards
};
```

Add to `TsNode` union.

### 4b. Factory (`lib/ir/builders.ts`)

```ts
handleSteps(subStepPath: number[], handler: TsNode, body: TsNode[]): TsHandleSteps
```

### 4c. Template (`lib/templates/backends/typescriptGenerator/handleSteps.mustache`)

Following `threadSteps.mustache` pattern:

```mustache
const {{{subVar}}} = {{{subStore}}} ?? 0;
{{{handlerDecl}}}
__ctx.pushHandler({{{handlerName}}});
try {
{{#bodyStatements}}
if ({{{subVar}}} <= {{{index}}}) {
  {{{code}}}
  {{{subStore}}} = {{{nextIndex}}};
}
{{/bodyStatements}}
} finally {
  __ctx.popHandler();
}
```

Run `pnpm run templates` after creating.

### 4d. PrettyPrint (`lib/ir/prettyPrint.ts`)

Add `handleSteps` case. Render template with `subKey = node.subStepPath.join("_")`, `subVar = __sub_${subKey}`, `subStore = __stack.locals.__substep_${subKey}`.

### 4e. Builder (`lib/backends/typescriptBuilder.ts`)

**Add `processNode` case:**
```ts
case "handleBlock":
  return this.processHandleBlockWithSteps(node);
```

**New method `processHandleBlockWithSteps`:**

1. Capture `subStepPath = [...this._subStepPath]`
2. Build handler arrow function:
   - **Inline**: compile handler body (NO substep tracking). Use unique handler name like `__handler_${subKey}`.
   - **Function ref**: `async (__data) => await myPolicy(__data, { ctx: __ctx, threads: new ThreadStore(), interruptData: undefined })`
3. Process handle body: `node.body.map((stmt, i) => { this._subStepPath.push(i); ... this._subStepPath.pop(); })`
4. Return `ts.handleSteps(subStepPath, handler, bodyNodes)`

**Modify `processReturnStatement`:**

When return value is `functionCall` named `approve` or `reject`:
- `return approve` → `return { type: "approve" }`
- `return approve "yes"` → `return { type: "approve", value: "yes" }`
- `return reject` → `return { type: "reject" }`
- `return reject "reason"` → `return { type: "reject", value: "reason" }`

**Modify interrupt templates:**

Both `interruptAssignment.mustache` and `interruptReturn.mustache`: replace `interrupt(...)` with `interruptWithHandlers(...)` in the else branch, and add `isRejected`/`isApproved` checks.

For `interruptReturn.mustache` else branch:
```
const __handlerResult = await interruptWithHandlers({{{interruptArgs}}}, __ctx);
if (isRejected(__handlerResult)) {
  {{#nodeContext}}return { messages: __threads, data: undefined };{{/nodeContext}}
  {{^nodeContext}}return { data: undefined };{{/nodeContext}}
}
if (isApproved(__handlerResult)) {
  // continue past interrupt
} else {
  const __checkpointId = __ctx.checkpoints.create(__ctx);
  __handlerResult.checkpointId = __checkpointId;
  __handlerResult.checkpoint = __ctx.checkpoints.get(__checkpointId);
  {{#nodeContext}}return { messages: __threads, data: __handlerResult };{{/nodeContext}}
  {{^nodeContext}}return __handlerResult;{{/nodeContext}}
}
```

For `interruptAssignment.mustache` else branch: similar, with `approved` assigning the value.

---

## Phase 5: Integration Tests

### Generator fixtures (`tests/typescriptGenerator/`)
- `handleBlock.agency` + `.mts` — inline handler
- `handleBlockFunctionRef.agency` + `.mts` — function ref handler

### Runtime tests (`tests/agency-js/`)
- `handle-approve/` — approve continues execution
- `handle-reject/` — reject halts function, calling code continues
- `handle-nested/` — inner approves, outer rejects → rejection wins
- `handle-with-function/` — function ref handler
- `handle-tool-call/` — rejection sends custom message to LLM
- `handle-approve-value/` — `return approve "yes"`, assigned interrupt gets value
- `handle-no-handler/` — backward compat: no handler, interrupt reaches TypeScript

---

## Files Changed Summary

| File | Change | Phase |
|------|--------|-------|
| `lib/runtime/types.ts` | Add HandlerFn, HandlerResult, Rejected, Approved | 1 |
| `lib/runtime/state/context.ts` | Add handlers stack, pushHandler, popHandler | 1 |
| `lib/runtime/interrupts.ts` | Add interruptWithHandlers, isRejected, isApproved | 1 |
| `lib/runtime/prompt.ts` | Add isRejected check in executeToolCalls | 1 |
| `lib/runtime/index.ts` | Export new functions | 1 |
| `lib/templates/.../imports.mustache` | Add new runtime imports | 1 |
| `lib/types/handleBlock.ts` | **New** — HandleBlock AST type | 2 |
| `lib/types.ts` | Add to AgencyNode union | 2 |
| `lib/parsers/handleBlock.ts` | **New** — Parser | 2 |
| `lib/parsers/handleBlock.test.ts` | **New** — Parser tests | 2 |
| `lib/parser.ts` | Wire handleBlockParser | 2 |
| `lib/parsers/function.ts` | Add to bodyParser | 2 |
| `lib/preprocessors/typescriptPreprocessor.ts` | ~12 locations for handleBlock | 3 |
| `lib/utils/node.ts` | walkNodes + getAllVariablesInBody | 3 |
| `lib/ir/tsIR.ts` | TsHandleSteps type | 4 |
| `lib/ir/builders.ts` | handleSteps factory | 4 |
| `lib/templates/.../handleSteps.mustache` | **New** — Template | 4 |
| `lib/ir/prettyPrint.ts` | handleSteps rendering | 4 |
| `lib/backends/typescriptBuilder.ts` | processHandleBlockWithSteps, approve/reject in returns | 4 |
| `lib/templates/.../interruptAssignment.mustache` | Use interruptWithHandlers | 4 |
| `lib/templates/.../interruptReturn.mustache` | Use interruptWithHandlers | 4 |

## Verification

1. `pnpm run templates` — compile new mustache templates
2. `pnpm run build` — verify TypeScript compiles
3. `pnpm test:run` — all existing tests pass (no regressions)
4. Parser tests: `pnpm test -- handleBlock`
5. Generator fixtures: `make fixtures` then verify generated `.mts` files
6. Integration tests: run `tests/agency-js/handle-*` fixtures
7. Manual test: compile a `.agency` file with handle block, inspect generated TypeScript

## Future Work (not in scope)
- **Effect annotations**: `effect: read/write/irreversible` on functions that auto-generate interrupts with structured data. Sugar on top of the handler system.
- **Handler return type enforcement**: type checker verifies handler functions always return approve/reject.
- **Capability attenuation with `uses`**: combine the capability system (`uses` keyword) with handlers for two-gate security.
- **Audit integration**: emit `handlerApprove`/`handlerReject` audit entries in `interruptWithHandlers`.
