# Block Substep Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give block arguments their own Runner and StateStack frame so interrupts can pause and resume mid-block.

**Architecture:** Blocks compile to inline async arrow functions (as now) but with internal function-like setup: `setupFunction` to push a state frame, a `Runner` for substep tracking, `processBodyAsParts` for the body, and `stateStack.pop()` in a finally block. The block's Runner is named `runner` (shadowing the caller's — safe inside the arrow function scope) so that `TsRunnerStep` IR nodes work without modification. The block's state frame is `__bstack` (distinct from caller's `__stack`), with `__self = __bstack.locals`. Captured variables from the enclosing scope remain accessible as `__stack.locals.xxx` (not shadowed). Block-local variables use scope type `"block"` → `__bstack.locals`, block params use `"blockArgs"` → `__bstack.args`.

**Tech Stack:** TypeScript, tarsec, vitest

---

## Background

Currently, block bodies compile to plain statements inside an async arrow function — no substep tracking, no state frame, no interrupt support. This plan upgrades blocks to have their own execution infrastructure while keeping them as inline closures (not top-level functions) so captured variables work via standard JavaScript closure.

### Key design decisions

1. **Block's Runner is named `runner`** — this shadows the caller's `runner` inside the arrow function scope, which is safe. This means `TsRunnerStep` IR nodes (which hardcode `runner` in prettyPrint) work without any IR changes.
2. **Block's stack is `__bstack`** — distinct from caller's `__stack`, so captured variables using `__stack.locals.xxx` still resolve to the caller's frame.
3. **`__self = __bstack.locals`** — so `ts.self()` references (used by `processBodyAsParts` for `__retryable` etc.) resolve to the block's frame.
4. **`processBodyAsParts`** generates the body — giving us runner steps, audit logging, source maps, and retryable tracking for free.
5. **Block returns use `runner.halt(value)`** — then the block function returns `runner.haltResult`. This is the raw value, not wrapped in `{data, messages}`. The callee uses it directly. When an interrupt occurs inside the block, `runner.halt(interruptResult)` stores the interrupt, and the callee's existing interrupt checking (`isInterrupt`) catches it.
6. **Reference semantics for captured variables** — blocks capture by closure (reference), not by copy. Copy semantics are deferred to Stage 3 (fork isolation).
7. **Interrupt propagation from block calls** — the callee already wraps function calls with interrupt checking in the current generated code. Need to verify this works for block-type parameter calls; if not, add it.

### Generated code shape

```typescript
// Agency: sample(5) as x { let y = x * 2; return y }
await sample(5, async (x: number) => {
  const __bsetup = setupFunction({ state: { ctx: __ctx, threads: __threads } });
  const __bstack = __bsetup.stack;
  const __self = __bstack.locals;
  __bstack.args.x = x;
  const runner = new Runner(__ctx, __bstack, {
    state: __bstack, moduleId: "mod.agency", scopeName: "__block_0"
  });
  try {
    await runner.step(0, async (runner) => {
      __bstack.locals.y = __bstack.args.x * 2;
    });
    await runner.step(1, async (runner) => {
      runner.halt(__bstack.locals.y);
    });
    return runner.halted ? runner.haltResult : undefined;
  } finally {
    __ctx.stateStack.pop();
  }
}, { ctx: __ctx, threads: new ThreadStore(), interruptData: __state?.interruptData });
```

### Files overview

| File | Change |
|------|--------|
| `lib/ir/tsIR.ts` | Add `"block"` and `"blockArgs"` to TsScopedVar scope union |
| `lib/ir/prettyPrint.ts` | Map block scopes to `__bstack.locals` / `__bstack.args` |
| `lib/types.ts` | Add `"block"` and `"blockArgs"` to ScopeType |
| `lib/preprocessors/typescriptPreprocessor.ts` | Detect block body context during scope resolution |
| `lib/backends/typescriptBuilder.ts` | Rewrite block compilation with Runner/setupFunction |
| `tests/typescriptGenerator/blockBasic.mjs` | Regenerate fixture |
| `tests/typescriptGenerator/blockParams.mjs` | Regenerate fixture |
| `tests/agency/blocks/block-interrupt.agency` | **New** — interrupt inside block e2e test |
| `tests/agency/blocks/block-interrupt.test.json` | **New** |
| `tests/agency/blocks/block-multi-call.agency` | **New** — block called multiple times |
| `tests/agency/blocks/block-multi-call.test.json` | **New** |

---

### Task 1: Add block scope types to IR, types, and prettyPrint

**Files:**
- Modify: `lib/ir/tsIR.ts`
- Modify: `lib/ir/prettyPrint.ts`
- Modify: `lib/types.ts`

- [ ] **Step 1: Add scope types to TsScopedVar**

In `lib/ir/tsIR.ts`, find the `TsScopedVar` interface and add `"block"` and `"blockArgs"` to its scope union.

- [ ] **Step 2: Add prefix mapping in prettyPrint**

In `lib/ir/prettyPrint.ts`, update `scopeToPrefix`:
- `"block"` → `"__bstack.locals"`
- `"blockArgs"` → `"__bstack.args"`

- [ ] **Step 3: Add to ScopeType in types.ts**

In `lib/types.ts`, add `"block"` and `"blockArgs"` to the `ScopeType` union type.

- [ ] **Step 4: Build and verify**

Run: `pnpm run build` — should pass with no errors.
Run: `pnpm test:run` — all existing tests should pass (no behavior change yet).

- [ ] **Step 5: Commit**

```
feat: add block and blockArgs scope types to IR and type system
```

---

### Task 2: Add block scope resolution in the preprocessor

The preprocessor's `resolveVariableScopes` already walks into block bodies via `getAllVariablesInBodyArray(node.body)`. We need to detect when a variable is inside a block body and scope it accordingly. Block params → `"blockArgs"`, new variables in block body → `"block"`, references to outer scope variables → keep original scope (captured via closure).

**Files:**
- Modify: `lib/preprocessors/typescriptPreprocessor.ts`

**Key insight:** `getAllVariablesInBodyArray` already yields variables from block bodies as part of the function body walk. We don't add a separate walk — instead, we track which variables are block params and which are new assignments inside blocks.

- [ ] **Step 1: Collect block param names and block-local variables**

In `resolveVariableScopes`, after collecting funcArgs and before the variable resolution loop, scan for function calls with blocks in the function body. For each block, record its param names. During the existing variable walk, check if a variable is a block param or a new block-local variable.

The approach: for each function/graphNode being processed, walk its body once to find all function calls with blocks. For each block, collect param names into a set. Also build a set of variable names that are first-assigned inside a block body (block-locals). Then during the main resolution walk, check these sets.

One way to identify if a variable node is "inside a block body": the `getAllVariablesInBody` function recursively yields from block bodies. We can add a wrapper that tracks whether we're currently inside a block.

Alternatively: pre-collect block param names per function, and use a separate walk of just the block bodies to identify block-local assignments.

```typescript
// After funcArgs[nodeName] = [...] and localVarsInFunction[nodeName] = new Set():

// Collect block param names and block-local variable names for this function/node
const blockParamNames = new Set<string>();
const blockLocalNames = new Set<string>();

// Walk body to find blocks
for (const { node: bodyNode } of walkNodesArray(node.body)) {
  if (bodyNode.type === "functionCall" && bodyNode.block) {
    for (const param of bodyNode.block.params) {
      blockParamNames.add(param.name);
    }
    // Walk block body to find block-local assignments
    for (const { node: blockVarNode } of getAllVariablesInBodyArray(bodyNode.block.body)) {
      if (blockVarNode.type === "assignment") {
        const name = blockVarNode.variableName;
        if (!blockParamNames.has(name) && lookupScope(nodeName, name) === null) {
          blockLocalNames.add(name);
        }
      }
    }
  }
}
```

Then during the variable resolution loop (the existing `for (const { node: varNode } of varsDefinedInFunction)` loop), add checks:

```typescript
if (varNode.type === "assignment") {
  if (blockParamNames.has(varNode.variableName)) {
    varNode.scope = "blockArgs";
  } else if (blockLocalNames.has(varNode.variableName)) {
    varNode.scope = "block";
  } else {
    // existing logic
  }
} else if (varNode.type === "variableName") {
  if (blockParamNames.has(varNode.value)) {
    varNode.scope = "blockArgs";
  } else if (blockLocalNames.has(varNode.value)) {
    varNode.scope = "block";
  } else {
    // existing logic
  }
}
```

Note: This has a limitation — if a variable name is used both inside and outside a block in the same function, it'll be incorrectly tagged. For now this is acceptable since blocks are a new feature and such collisions are unlikely. A proper fix would track which variables are in block scope using ancestor information.

- [ ] **Step 2: Build and run tests**

Run: `pnpm run build` — should pass.
Run: `pnpm test:run` — should pass (variable scoping changes don't affect generated code until the builder uses them).

- [ ] **Step 3: Commit**

```
feat: add block variable scope resolution in preprocessor
```

---

### Task 3: Rewrite block compilation in the builder

Replace the current inline-statement block compilation with function-like setup: `setupFunction`, `Runner`, `processBodyAsParts`, try/finally.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

**Important:** Read `lib/runtime/node.ts` for `setupFunction` signature. Read `lib/runtime/runner.ts` for `Runner` constructor. Read the existing `processFunctionDefinition` method for the function setup pattern we're replicating.

- [ ] **Step 1: Add block scope type to the builder's scope stack**

The builder uses `startScope`/`endScope` to track the current scope. Find the scope type definition and add a block variant. This is needed so `processReturnStatement` and other scope-dependent logic can detect when we're inside a block.

- [ ] **Step 2: Add `_blockCounter` field**

Add a `private _blockCounter: number = 0;` field to the builder class for generating unique block scope names.

- [ ] **Step 3: Update processReturnStatement for block scope**

When the current scope is a block, `return expr` should compile to `runner.halt(value)` (which halts the block's runner and stores the value). Replace the `insideBlockBody` check:

```typescript
// Replace: if (this.insideHandlerBody || this.insideBlockBody) {
// With:
if (this.insideHandlerBody) {
  return ts.return(this.processNode(node.value));
}
if (this.getCurrentScope().type === "block") {
  const valueNode = this.processNode(node.value);
  return ts.raw(`runner.halt(${this.str(valueNode)})`);
}
```

Note: `this.str(valueNode)` converts a TsNode to a string using `printTs`. Verify this method exists on the builder; it may be named differently. Check how other code in the builder converts TsNodes to strings.

- [ ] **Step 4: Rewrite block compilation in generateFunctionCallExpression**

Replace the `if (node.block)` section. The new block arrow function should:
1. Call `setupFunction({ state: { ctx: __ctx, threads: __threads } })` to get a state frame
2. Set `__bstack = __bsetup.stack`, `__self = __bstack.locals`
3. Store block params in `__bstack.args`
4. Create `runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId, scopeName })` — using `runner` to shadow the caller's runner
5. Enter block scope, process body with `processBodyAsParts`
6. Wrap in try/finally with `__ctx.stateStack.pop()` in the finally
7. After try: `return runner.halted ? runner.haltResult : undefined`

```typescript
if (node.block) {
  const blockParam = paramList?.find((p) => p.typeHint?.type === "blockType");
  const blockType = blockParam?.typeHint?.type === "blockType" ? blockParam.typeHint : undefined;

  const blockParams: TsParam[] = node.block.params.map((p, i) => ({
    name: p.name,
    typeAnnotation: blockType?.params[i] ? formatTypeHint(blockType.params[i].typeAnnotation) : "any",
  }));

  const blockName = `__block_${this._blockCounter++}`;
  this.startScope({ type: "block", blockName });
  this._sourceMapBuilder.enterScope(this.moduleId, blockName);
  const bodyParts = this.processBodyAsParts(node.block.body);
  this._sourceMapBuilder.exitScope();
  this.endScope();

  const setupStmts: TsNode[] = [];

  // Setup: state frame, stack, self
  setupStmts.push(ts.raw(`const __bsetup = setupFunction({ state: { ctx: __ctx, threads: __threads } })`));
  setupStmts.push(ts.raw(`const __bstack = __bsetup.stack`));
  setupStmts.push(ts.raw(`const __self = __bstack.locals`));

  // Store block params in __bstack.args
  for (const param of node.block.params) {
    setupStmts.push(ts.raw(`__bstack.args[${JSON.stringify(param.name)}] = ${param.name}`));
  }

  // Create runner (shadows caller's runner — intentional)
  setupStmts.push(ts.raw(
    `const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: ${JSON.stringify(this.moduleId)}, scopeName: ${JSON.stringify(blockName)} })`
  ));

  // try { bodyParts; return } finally { pop }
  // Check how ts.tryCatch is constructed — it may require a catch body.
  // If so, pass ts.statements([]) as catch body and undefined as catch param.
  setupStmts.push(ts.raw("try {"));
  setupStmts.push(...bodyParts);
  setupStmts.push(ts.raw("return runner.halted ? runner.haltResult : undefined;"));
  setupStmts.push(ts.raw("} finally {"));
  setupStmts.push(ts.raw("__ctx.stateStack.pop();"));
  setupStmts.push(ts.raw("}"));

  const blockFn = ts.arrowFn(blockParams, ts.statements(setupStmts), { async: true });
  argNodes.push(blockFn);
}
```

Note: Using raw strings for try/finally is a pragmatic choice to avoid issues with `ts.tryCatch`'s catch body requirement. If you prefer structured IR, check whether `ts.tryCatch` accepts `undefined` for the catch body — it may need a code change to the `TsTryCatch` interface to make catch optional.

- [ ] **Step 5: Remove the `insideBlockBody` flag**

Remove the `insideBlockBody` property declaration, and all places where it's set/read. The block scope check in `processReturnStatement` replaces it.

- [ ] **Step 6: Build**

Run: `pnpm run build` — should pass. Existing tests will likely have fixture mismatches since generated code changed.

- [ ] **Step 7: Commit**

```
feat: rewrite block compilation with internal Runner and state frame
```

---

### Task 4: Verify interrupt propagation for block-type parameter calls

The review identified that block parameter calls in the callee may already get interrupt wrapping. Verify this before adding anything.

**Files:**
- Check: `tests/typescriptGenerator/blockParams.mjs` (the generated fixture)

- [ ] **Step 1: Check if block parameter calls already get interrupt checking**

Look at the generated code for `mapItems` in `blockParams.mjs`. Find where `block(item)` is called. Check if the generated code includes an `isInterrupt` check after the call.

If it does: no changes needed. Document why it works (the builder already treats all function calls with potential interrupt propagation).

If it doesn't: add `isBlockParameterCall` detection to the builder and generate interrupt-checking wrapper code. The method should check if the function name matches a parameter with `BlockType` type hint in the current function definition.

- [ ] **Step 2: Commit (if changes made)**

```
feat: add interrupt propagation for block-type parameter calls
```

---

### Task 5: Regenerate fixtures and verify all tests pass

**Files:**
- Modify: `tests/typescriptGenerator/blockBasic.mjs`
- Modify: `tests/typescriptGenerator/blockParams.mjs`

- [ ] **Step 1: Rebuild and regenerate fixtures**

```bash
pnpm run build
node dist/scripts/regenerate-fixtures.js
```

Verify block fixtures were updated.

- [ ] **Step 2: Inspect the regenerated fixtures**

Read the generated `.mjs` files and verify:
- Block arrow function contains `setupFunction`, `__bstack`, runner steps
- Block params stored in `__bstack.args`
- Block-local variables use `__bstack.locals`
- Captured variables use `__stack.locals` (caller's frame)
- try/finally with `stateStack.pop()` present
- Return uses `runner.halt(value)` pattern

- [ ] **Step 3: Run all unit/integration tests**

Run: `pnpm test:run`
Expected: all tests pass.

- [ ] **Step 4: Run execution tests**

Run: `pnpm run agency test tests/agency/blocks`
Expected: block-basic and block-params pass.

- [ ] **Step 5: Commit**

```
test: regenerate fixtures for block substep tracking
```

---

### Task 6: Add interrupt-in-block end-to-end test

**Files:**
- Create: `tests/agency/blocks/block-interrupt.agency`
- Create: `tests/agency/blocks/block-interrupt.test.json`

- [ ] **Step 1: Read interrupt testing docs**

Read `docs/INTERRUPT_TESTING.md` for the test format and interrupt handler syntax.

- [ ] **Step 2: Write the test agency file**

```agency
def process(items: any[], block: (any) => any): any[] {
  let results: any[] = []
  for (item in items) {
    let result = block(item)
    results = results.concat([result])
  }
  return results
}

node main() {
  let doubled = process([10, 20]) as x {
    interrupt("approve ${x}")
    return x * 2
  }
  return doubled
}
```

- [ ] **Step 3: Write the test.json**

Use the interrupt handler format from the docs. The test should approve each interrupt so execution continues. Expected output: `[20,40]`.

- [ ] **Step 4: Run the test**

Run: `pnpm run build && pnpm run agency test tests/agency/blocks/block-interrupt`
Expected: passes.

- [ ] **Step 5: Commit**

```
test: add interrupt-in-block end-to-end test
```

---

### Task 7: Add multi-invocation block test

Verify that a block called multiple times by the callee works correctly — each invocation gets a fresh state frame.

**Files:**
- Create: `tests/agency/blocks/block-multi-call.agency`
- Create: `tests/agency/blocks/block-multi-call.test.json`

- [ ] **Step 1: Write the test**

```agency
def callTwice(block: () => number): number[] {
  let a = block()
  let b = block()
  return [a, b]
}

node main() {
  let results = callTwice() as {
    return 42
  }
  return results
}
```

Expected: `[42,42]`. Each invocation creates a fresh state frame via `setupFunction`, so there's no state leakage between calls.

- [ ] **Step 2: Write the test.json**

```json
{
  "sourceFile": "block-multi-call.agency",
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "[42,42]",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "Block called twice gets fresh state each time"
    }
  ]
}
```

- [ ] **Step 3: Run the test**

Run: `pnpm run build && pnpm run agency test tests/agency/blocks/block-multi-call`
Expected: passes.

- [ ] **Step 4: Commit**

```
test: add multi-invocation block test
```

---

### Task 8: Run full test suite and clean up

- [ ] **Step 1: Run all unit/integration tests**

Run: `pnpm test:run`
Expected: all tests pass.

- [ ] **Step 2: Run all block execution tests**

Run: `pnpm run agency test tests/agency/blocks`
Expected: all block tests pass.

- [ ] **Step 3: Clean up generated files**

```bash
rm -f tests/agency/blocks/*.js
```

- [ ] **Step 4: Final commit**

```
chore: clean up after block substep tracking implementation
```
