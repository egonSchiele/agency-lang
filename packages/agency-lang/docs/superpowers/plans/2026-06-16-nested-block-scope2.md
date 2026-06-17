# Nested Block Scope Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a variable reference inside a nested block resolve to the correct enclosing block's frame, so writes from an inner block update the outer block's variable instead of silently creating a shadow.

**Architecture:** Agency block scope is lexical, and generated nested blocks are already lexically-nested JS arrow functions. We (1) teach the preprocessor to resolve each block reference to its owning block and record the relative block-nesting distance as `blockDepth`, and (2) give every block's runtime frame a unique, closure-visible binding `__bframe_<blockName>` so codegen can address an ancestor block's frame by name. Depth `0` (the current/innermost block) keeps emitting `__bstack` exactly as today, so only genuine cross-block references change.

**Tech Stack:** TypeScript; the Agency compiler pipeline (`parse → SymbolTable.build → buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build → printTs → esbuild`); typestache templates (`*.mustache`); Vitest unit tests; Agency execution tests (`tests/agency/`, no LLM calls).

---

## Background: the two defects (read before starting)

1. **Preprocessor flattens nested blocks.** `lib/preprocessors/typescriptPreprocessor.ts` "Phase 1" (~line 1351) processes each `functionCall`-with-block via `getAllVariablesInBodyArray(block.body)`, which recurses through nested `block.body` (`lib/utils/node.ts:178-182`) and decides ownership with `lookupScope` — which only knows node-locals/globals, never *outer-block* locals. So an inner `y = 2` referencing an outer block's `y` is mis-invented as a fresh inner-block local.

2. **Codegen can't address an ancestor block's frame.** Block vars emit `__bstack.locals.NAME` (`lib/ir/prettyPrint.ts:24`). `const __bstack = __bsetup.stack` is re-declared in every block setup (`lib/templates/backends/typescriptGenerator/blockSetup.mustache:2`; fork variant `forkBlockSetup.mustache:8`). esbuild renames the shadowed inner declaration, so `__bstack` inside an inner block always means the *innermost* frame.

The fix records the owning block (`blockDepth`) in the preprocessor and emits `__bframe_<owningBlockName>.locals.NAME` for `blockDepth > 0`.

## File map

- `lib/types.ts` — add `blockDepth?: number` to `Assignment`; confirm/add it on the variable-reference node (`VariableName`/`Literal` variant carrying `scope`).
- `lib/ir/tsIR.ts` — add `blockFrameVar?: string` to `TsScopedVar`.
- `lib/ir/builders.ts` — add optional `blockFrameVar` param to `ts.scopedVar`.
- `lib/ir/prettyPrint.ts` — in the `scopedVar` case, honor `blockFrameVar` for `block`/`blockArgs`.
- `lib/backends/typescriptBuilder/scopeManager.ts` — add `blockFrameVar(depth)` resolver.
- `lib/backends/typescriptBuilder/assignmentEmitter.ts` — thread `blockDepth` through `scopedAssign`/`lhs`/`sliceAssign`; new `resolveBlockFrameVar` dep.
- `lib/backends/typescriptBuilder.ts` — pass `blockDepth` at read sites and assignment sites; wire the `resolveBlockFrameVar` dep; pass a unique `frameVar` into the block-setup templates.
- `lib/templates/backends/typescriptGenerator/blockSetup.mustache` and `forkBlockSetup.mustache` — bind `const __bframe_<blockName> = __bstack;`.
- `tests/agency/blocks/` — new execution tests.
- Unit tests co-located: `lib/backends/typescriptBuilder/scopeManager.test.ts` (new), `lib/ir/prettyPrint.test.ts` (if present; else add).

## Conventions

- **Build:** after editing any `.mustache`, run `pnpm run templates` then `make`. After editing `.ts` only, `make` is enough. (`make` is required whenever stdlib/templates change.)
- **Single Agency execution test:** `pnpm run agency test tests/agency/blocks/<name>.agency` (compiles + runs; no LLM).
- **Unit tests:** `pnpm test:run -- <path>`.
- **Save test output to a file** (tests are slow/expensive): append `2>&1 | tee /tmp/out.txt` style is fine for unit tests, but for Agency tests redirect to a repo-local scratch file you delete afterward, e.g. `> out.log 2>&1`.
- Commit after each task.

---

### Task 1: End-to-end failing test (the repro)

Establishes the target behavior and proves the bug before touching code.

**Files:**
- Create: `tests/agency/blocks/nested-block-write.agency`
- Create: `tests/agency/blocks/nested-block-write.test.json`

- [ ] **Step 1: Write the Agency repro**

`tests/agency/blocks/nested-block-write.agency`:

```agency
def run(block: () -> void) {
  block()
}

node main(): number {
  let result = 0
  run() as {
    let y = 1
    run() as {
      y = 2
    }
    result = y
  }
  return result
}
```

- [ ] **Step 2: Write the test expectation**

`tests/agency/blocks/nested-block-write.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "inner block writes the outer block's variable; outer sees 2",
      "input": "",
      "expectedOutput": "2",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Build and run, confirm it FAILS**

Run:
```bash
make >/dev/null && pnpm run agency test tests/agency/blocks/nested-block-write.agency > nested-block-write.log 2>&1; tail -20 nested-block-write.log
```
Expected: FAIL — actual output `1`, expected `2` (proves defect #2 is live).

- [ ] **Step 4: Commit**

```bash
git add tests/agency/blocks/nested-block-write.agency tests/agency/blocks/nested-block-write.test.json
git commit -m "test: failing repro for nested-block variable write"
```

---

### Task 2: Add `blockDepth` to the AST and `blockFrameVar` to the IR

Pure plumbing — no behavior change yet (`blockDepth` defaults to `0`/absent, which keeps current output).

**Files:**
- Modify: `lib/types.ts` (the `Assignment` type ~line 172; the variable-reference node that carries `scope?: ScopeType`)
- Modify: `lib/ir/tsIR.ts:280-303` (`TsScopedVar`)
- Modify: `lib/ir/builders.ts:423-429` (`ts.scopedVar`)

- [ ] **Step 1: Add `blockDepth` to `Assignment`**

In `lib/types.ts`, in the `Assignment` type, add after `scope?: ScopeType;`:

```ts
  /** For block/blockArgs scope only: how many block scopes up the lexical
   *  chain the owning block is. 0 (or absent) = the current/innermost block. */
  blockDepth?: number;
```

- [ ] **Step 2: Add `blockDepth` to the variable-reference node**

Find the node type that represents a bare variable reference and carries `scope` (the `variableName` literal — search `lib/types.ts` for the literal variant whose `type: "variableName"`). Add the same optional field:

```ts
  blockDepth?: number;
```

Verify by grepping that both `assignment` and `variableName` nodes accept it:
```bash
grep -n "blockDepth" lib/types.ts
```
Expected: two matches.

- [ ] **Step 3: Add `blockFrameVar` to `TsScopedVar`**

In `lib/ir/tsIR.ts`, inside `TsScopedVar` (after `moduleId?: string;`):

```ts
  /** For `block`/`blockArgs` scope: the unique frame binding to read
   *  through (`__bframe_<blockName>`). Set by the builder when the var
   *  is owned by an *ancestor* block (blockDepth > 0). When absent the
   *  printer falls back to `__bstack` (the current/innermost block). */
  blockFrameVar?: string;
```

- [ ] **Step 4: Add the optional param to `ts.scopedVar`**

In `lib/ir/builders.ts`, replace the `scopedVar` builder:

```ts
  scopedVar(
    name: string,
    scope: TsScopedVar["scope"],
    moduleId?: string,
    blockFrameVar?: string,
  ): TsScopedVar {
    return { kind: "scopedVar", name, scope, moduleId, blockFrameVar };
  },
```

- [ ] **Step 5: Typecheck**

Run:
```bash
pnpm exec tsc --noEmit > tsc.log 2>&1; tail -5 tsc.log
```
Expected: no new errors (all new fields optional).

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/ir/tsIR.ts lib/ir/builders.ts
git commit -m "feat: add blockDepth (AST) and blockFrameVar (IR) plumbing"
```

---

### Task 3: Pretty-print `blockFrameVar`

Make the printer honor `blockFrameVar`. Still inert (nothing sets it yet).

**Files:**
- Modify: `lib/ir/prettyPrint.ts:271-312` (the `scopedVar` case)
- Test: `lib/ir/prettyPrint.test.ts` (create if absent)

- [ ] **Step 1: Write the failing unit test**

In `lib/ir/prettyPrint.test.ts` add:

```ts
import { describe, it, expect } from "vitest";
import { printTs } from "./prettyPrint.js";
import { ts } from "./builders.js";

describe("scopedVar block frame addressing", () => {
  it("uses __bstack for a current-block var (no frame var)", () => {
    expect(printTs(ts.scopedVar("y", "block", "m"))).toBe("__bstack.locals.y");
  });

  it("uses the ancestor frame binding when blockFrameVar is set", () => {
    expect(printTs(ts.scopedVar("y", "block", "m", "__bframe___block_0"))).toBe(
      "__bframe___block_0.locals.y",
    );
  });

  it("addresses ancestor block args via blockFrameVar", () => {
    expect(printTs(ts.scopedVar("p", "blockArgs", "m", "__bframe___block_0"))).toBe(
      "__bframe___block_0.args.p",
    );
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run:
```bash
pnpm test:run -- lib/ir/prettyPrint.test.ts > pp.log 2>&1; tail -20 pp.log
```
Expected: the two `blockFrameVar` cases FAIL (printer ignores the field).

- [ ] **Step 3: Implement**

In `lib/ir/prettyPrint.ts`, inside `case "scopedVar":`, immediately before `const prefix = scopeToPrefix(node.scope);`, insert:

```ts
      if (
        (node.scope === "block" || node.scope === "blockArgs") &&
        node.blockFrameVar
      ) {
        const sub = node.scope === "block" ? "locals" : "args";
        return `${node.blockFrameVar}.${sub}.${node.name}`;
      }
```

Leave `scopeToPrefix` unchanged — its `block`/`blockArgs` → `__bstack.*` mappings remain the default for the no-frame-var (current-block) case.

- [ ] **Step 4: Run tests, confirm pass**

Run:
```bash
pnpm test:run -- lib/ir/prettyPrint.test.ts > pp.log 2>&1; tail -20 pp.log
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ir/prettyPrint.ts lib/ir/prettyPrint.test.ts
git commit -m "feat: pretty-print scopedVar through blockFrameVar"
```

---

### Task 4: `ScopeManager.blockFrameVar(depth)` resolver

Maps a relative block depth to the owning block's frame binding using the live scope stack.

**Files:**
- Modify: `lib/backends/typescriptBuilder/scopeManager.ts`
- Test: `lib/backends/typescriptBuilder/scopeManager.test.ts` (create)

- [ ] **Step 1: Write the failing unit test**

`lib/backends/typescriptBuilder/scopeManager.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ScopeManager } from "./scopeManager.js";

// CompilationUnit is only used for type-alias/return-type queries, which
// blockFrameVar does not touch, so a cast-through empty object is safe here.
const sm = () => new ScopeManager({} as any);

describe("ScopeManager.blockFrameVar", () => {
  it("returns undefined at depth 0 (current block keeps __bstack)", () => {
    const m = sm();
    m.push({ type: "node", nodeName: "main" });
    m.push({ type: "block", blockName: "__block_0" });
    expect(m.blockFrameVar(0)).toBeUndefined();
  });

  it("returns the ancestor frame binding at depth > 0", () => {
    const m = sm();
    m.push({ type: "node", nodeName: "main" });
    m.push({ type: "block", blockName: "__block_0" }); // outer
    m.push({ type: "block", blockName: "__block_1" }); // inner (current)
    expect(m.blockFrameVar(1)).toBe("__bframe___block_0");
    expect(m.blockFrameVar(0)).toBeUndefined();
  });

  it("walks two levels up", () => {
    const m = sm();
    m.push({ type: "node", nodeName: "main" });
    m.push({ type: "block", blockName: "__block_0" });
    m.push({ type: "block", blockName: "__block_1" });
    m.push({ type: "block", blockName: "__block_2" });
    expect(m.blockFrameVar(2)).toBe("__bframe___block_0");
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run:
```bash
pnpm test:run -- lib/backends/typescriptBuilder/scopeManager.test.ts > sm.log 2>&1; tail -20 sm.log
```
Expected: FAIL — `blockFrameVar` is not a function.

- [ ] **Step 3: Implement**

In `lib/backends/typescriptBuilder/scopeManager.ts`, add this method to the `ScopeManager` class (e.g. just after `currentName()`):

```ts
  /**
   * Resolve a relative block depth to the frame binding to read through.
   *
   * `depth` counts block scopes outward from the innermost block: 0 = the
   * current block, 1 = its enclosing block, etc. Depth 0 returns
   * `undefined` so callers keep emitting the existing `__bstack` alias
   * (no fixture churn for non-nested blocks). Depth > 0 returns the
   * unique `__bframe_<blockName>` binding that the block-setup template
   * declares for the owning block, which is in lexical closure scope.
   */
  blockFrameVar(depth: number): string | undefined {
    if (!depth) return undefined;
    const blocks = this.stack.filter(
      (s): s is Extract<Scope, { type: "block" }> => s.type === "block",
    );
    const idx = blocks.length - 1 - depth;
    if (idx < 0) {
      throw new Error(
        `blockFrameVar: depth ${depth} exceeds block nesting (${blocks.length})`,
      );
    }
    return `__bframe_${blocks[idx].blockName}`;
  }
```

- [ ] **Step 4: Run tests, confirm pass**

Run:
```bash
pnpm test:run -- lib/backends/typescriptBuilder/scopeManager.test.ts > sm.log 2>&1; tail -20 sm.log
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder/scopeManager.ts lib/backends/typescriptBuilder/scopeManager.test.ts
git commit -m "feat: ScopeManager.blockFrameVar depth resolver"
```

---

### Task 5: Emit the `__bframe_<blockName>` binding in block setups

Declare the unique per-block frame alias so ancestor references resolve. Inert until references use it (Tasks 6–7); for now it just adds one `const` line per block.

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/blockSetup.mustache`
- Modify: `lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache`
- Modify: `lib/backends/typescriptBuilder.ts` (3 block-setup call sites: ~1340, ~1384, ~2316 — add a `frameVar` template arg)

- [ ] **Step 1: Add the binding to `blockSetup.mustache`**

In `lib/templates/backends/typescriptGenerator/blockSetup.mustache`, after the line `const __self = __bsetup.stack;`-equivalent (currently lines 2–3: `const __bstack = __bsetup.stack;` / `const __self = __bstack.locals;`), add:

```
const {{{frameVar}}} = __bstack;
```

- [ ] **Step 2: Add the binding to `forkBlockSetup.mustache`**

In `forkBlockSetup.mustache`, after line 9 (`const __self = __bstack.locals;`), add:

```
const {{{frameVar}}} = __bstack;
```

(Placing it after `const __bstack = ...` keeps it valid for both the nested and non-nested branches, since `__bstack` is already bound at that point.)

- [ ] **Step 3: Pass `frameVar` from the three builder call sites**

In `lib/backends/typescriptBuilder.ts`, each of the three setup renders mints `blockName` via `this.steps.nextBlockName()`. Add `frameVar: \`__bframe_${blockName}\`` to each render args object:

`processBlockArgument` (~line 1340, `renderBlockSetup.default({...})`):
```ts
    const blockSetupCode = renderBlockSetup.default({
      params: block.params.map((p) => ({
        paramName: p.name,
        paramNameQuoted: JSON.stringify(p.name),
      })),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(blockName),
      frameVar: `__bframe_${blockName}`,
      body: bodyStr,
    });
```

`processBlockAsExpression` (~line 1384, same shape) — add the identical `frameVar: \`__bframe_${blockName}\`,` line.

`buildCallDescriptor` fork path (~line 2316, `renderForkBlockSetup.default({...})`):
```ts
    const blockSetupCode = renderForkBlockSetup.default({
      paramName,
      paramNameQuoted: JSON.stringify(paramName),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(blockName),
      frameVar: `__bframe_${blockName}`,
      body: bodyStr,
      isNested: isNestedInForkBlock,
    });
```

- [ ] **Step 4: Recompile templates + build**

Run:
```bash
pnpm run templates > tmpl.log 2>&1 && make > make.log 2>&1; tail -5 tmpl.log make.log
```
Expected: clean build. (If typestache complains about an unused/typed var, the generated `.ts` template type adds `frameVar: string` — that is expected.)

- [ ] **Step 5: Sanity-check the emitted binding**

Run:
```bash
printf 'def run(b: () -> void) { b() }\nnode main(): number { run() as { let y = 1\n return y } }\n' > scratch_b.agency
pnpm run compile scratch_b.agency >/dev/null 2>&1 && grep -n "__bframe_" scratch_b.js | head
rm -f scratch_b.agency scratch_b.js
```
Expected: at least one `const __bframe___block_0 = __bstack;` line.

- [ ] **Step 6: Commit**

```bash
git add lib/templates/backends/typescriptGenerator/blockSetup.mustache lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache lib/templates/backends/typescriptGenerator/blockSetup.ts lib/templates/backends/typescriptGenerator/forkBlockSetup.ts lib/backends/typescriptBuilder.ts
git commit -m "feat: bind unique __bframe_<blockName> alias per block setup"
```

---

### Task 6: Wire `blockDepth → blockFrameVar` at read and write sites

Now codegen actually addresses ancestor frames. Still inert end-to-end because the preprocessor sets `blockDepth = 0` everywhere until Task 7 — but unit-testable via a constructed scopedVar path. This task changes the builder read site and the `AssignmentEmitter` write path.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (read site ~842; `AssignmentEmitter` construction ~306; assignment call sites that pass `node.scope!`)
- Modify: `lib/backends/typescriptBuilder/assignmentEmitter.ts`

**Coverage invariant (read first).** The preprocessor's `resolveBlockScopes`
(Task 7) assigns `block`/`blockArgs` scope to exactly two AST node kinds:
`variableName` references and `assignment` targets. So those are the only two
codegen consumers that need `blockDepth` threading:

- **All `variableName` reads funnel through one site** (~842). Verified by
  tracing `processNode` (`typescriptBuilder.ts:496`): bare `variableName`
  → `generateLiteral` → the `variableName` case (~800/842); `valueAccess`
  bases recurse via `processValueAccess` → `this.processNode(node.base)`
  (~886); string-interpolation expressions recurse via
  `generateStringLiteralNode` → `this.processNode(segment.expression)`
  (~872). All land back at 842.
- **Assignment targets** go through `AssignmentEmitter.lhs`/`scopedAssign`
  (Steps 2-4) plus the validated-wrap site (~2705, Step 4).

The other `ts.scopedVar` call sites are NOT block consumers and need no change:
the function-call callee (~2150) and the `handle … with NAME` handler ref
(~3208) take a `FunctionCall`/handler scope produced by the separate
`lookupScope`-based resolution (preprocessor ~1436-1472), which only ever
returns `args`/`local`/`imported`/`global`/`static`/`functionRef` — never
`block`/`blockArgs`. Step 7 adds a grep that fails loudly if that ever changes.

- [ ] **Step 1: Read site — pass `blockFrameVar`**

In `lib/backends/typescriptBuilder.ts`, the `variableName` case currently ends (~line 842) with:
```ts
        return ts.scopedVar(literal.value, literal.scope!, this.moduleId);
```
Replace with:
```ts
        const blockFrameVar =
          literal.scope === "block" || literal.scope === "blockArgs"
            ? this.scopes.blockFrameVar(literal.blockDepth ?? 0)
            : undefined;
        return ts.scopedVar(
          literal.value,
          literal.scope!,
          this.moduleId,
          blockFrameVar,
        );
```

- [ ] **Step 2: AssignmentEmitter — add the resolver dep and thread `blockDepth`**

In `lib/backends/typescriptBuilder/assignmentEmitter.ts`:

Extend `AssignmentEmitterDeps`:
```ts
export type AssignmentEmitterDeps = {
  moduleId: string;
  processNode: (node: AgencyNode) => TsNode;
  buildCallDescriptor: (call: FunctionCall) => TsNode;
  buildStateConfig: () => TsNode | undefined;
  resolveBlockFrameVar: (blockDepth: number) => string | undefined;
};
```

Update `scopedAssign` to accept `blockDepth` and forward it:
```ts
  scopedAssign(
    scope: ScopeType,
    varName: string,
    value: TsNode,
    accessChain?: AccessChainElement[],
    blockDepth = 0,
  ): TsNode {
    if (
      accessChain &&
      accessChain.length > 0 &&
      accessChain[accessChain.length - 1].kind === "slice"
    ) {
      return this.sliceAssign(scope, varName, value, accessChain, blockDepth);
    }
    if (scope === "global" && (!accessChain || accessChain.length === 0)) {
      return ts.globalSet(this.deps.moduleId, varName, value);
    }
    return ts.assign(this.lhs(scope, varName, accessChain, blockDepth), value);
  }
```

Update `lhs`:
```ts
  lhs(
    scope: ScopeType,
    variableName: string,
    chain?: AccessChainElement[],
    blockDepth = 0,
  ): TsNode {
    const blockFrameVar =
      scope === "block" || scope === "blockArgs"
        ? this.deps.resolveBlockFrameVar(blockDepth)
        : undefined;
    return this.accessChain(
      ts.scopedVar(variableName, scope, this.deps.moduleId, blockFrameVar),
      chain,
    );
  }
```

Update `sliceAssign` signature + its `this.lhs(...)` call to forward `blockDepth`:
```ts
  private sliceAssign(
    scope: ScopeType,
    varName: string,
    value: TsNode,
    accessChain: AccessChainElement[],
    blockDepth = 0,
  ): TsNode {
    const sliceEl = accessChain[accessChain.length - 1] as Extract<
      AccessChainElement,
      { kind: "slice" }
    >;
    const baseChain =
      accessChain.length > 1 ? accessChain.slice(0, -1) : undefined;
    const base = this.lhs(scope, varName, baseChain, blockDepth);
    // ...unchanged below...
```

- [ ] **Step 3: Provide the resolver when constructing AssignmentEmitter**

In `lib/backends/typescriptBuilder.ts` (~line 306) where `this.assigns = new AssignmentEmitter({ ... })`, add to the deps object:
```ts
      resolveBlockFrameVar: (blockDepth: number) =>
        this.scopes.blockFrameVar(blockDepth),
```

- [ ] **Step 4: Pass `node.blockDepth` at the assignment call sites**

Update every `this.assigns.scopedAssign(node.scope!, variableName, ...)` / `this.assigns.lhs(node.scope!, ...)` call in `typescriptBuilder.ts` to forward `node.blockDepth ?? 0` as the trailing `blockDepth` argument. Known sites (verify with the grep below):

- `_processAssignmentInner` interrupt path (~2728): the `makeAssign` closure calls `this.assigns.scopedAssign(node.scope!, variableName, ts.raw(val), node.accessChain)` → add `, node.blockDepth ?? 0`.
- async/function-call assignment (~2748 `lhs`, ~2754 `scopedAssign`, ~2768 `scopedAssign`) → add `, node.blockDepth ?? 0`.
- plain assignment (~2825 `scopedAssign`) → add `, node.blockDepth ?? 0`.
- any remaining `scopedAssign`/`lhs` with an `Assignment` in scope (e.g. ~2993) → add `, node.blockDepth ?? 0`.
- `processAssignment` validated wrap (~2705) builds `ts.scopedVar(node.variableName, node.scope!, this.moduleId)` directly → replace with the block-frame-aware form:
  ```ts
      const blockFrameVar =
        node.scope === "block" || node.scope === "blockArgs"
          ? this.scopes.blockFrameVar(node.blockDepth ?? 0)
          : undefined;
      const varRef = ts.scopedVar(
        node.variableName,
        node.scope!,
        this.moduleId,
        blockFrameVar,
      );
  ```

Find every site to update:
```bash
grep -n "assigns.scopedAssign\|assigns.lhs\|ts.scopedVar(" lib/backends/typescriptBuilder.ts
```
For the closure at ~line 301 inside the AssignmentEmitter deps (`this.assigns.lhs(scope, varName, accessChain)`): that helper builds a `this.field = value` lowering where `scope` is already a resolved value and no `blockDepth` is in scope — leave it at the default `0` (it does not handle block-owned ancestor writes; covered by Risk note 3 verification).

- [ ] **Step 5: Build + run the existing block test suite (regression)**

Run:
```bash
make > make.log 2>&1 && pnpm run agency test tests/agency/blocks/block-name-collision.agency > reg.log 2>&1; tail -20 reg.log
```
Expected: PASS (depth-0 behavior unchanged → `__bstack`, output `110`).

- [ ] **Step 6: Verify the read-site invariant holds**

Confirm no other `ts.scopedVar` consumer can receive a block scope. List the
function-call/handler scope-resolution sites and confirm they never assign
`block`/`blockArgs`:
```bash
grep -n '\.scope = "block\|scope: "block\|blockArgs"' lib/preprocessors/typescriptPreprocessor.ts
```
Expected: matches appear ONLY inside `resolveBlockScopes` (Task 7), set on
`variableName`/`assignment` nodes — never on `functionCall`/`handleBlock`
handler nodes. If a future change makes a function-call or handler scope
resolve to `block`, sites ~2150/~3208 would also need `blockFrameVar`; this
grep is the tripwire.

- [ ] **Step 7: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/backends/typescriptBuilder/assignmentEmitter.ts
git commit -m "feat: address ancestor block frames via blockDepth in codegen"
```

---

### Task 7: Preprocessor — nesting-aware lexical resolution

The semantic core. Replaces the flat Phase-1 block loop with a resolver that knows the block chain and records `blockDepth`. After this task the Task 1 repro passes.

**Files:**
- Modify: `lib/preprocessors/typescriptPreprocessor.ts` (replace the Phase-1 block loop, ~lines 1351-1392)

- [ ] **Step 1: Inspect the current Phase-1 block loop**

Read `lib/preprocessors/typescriptPreprocessor.ts:1346-1392` to confirm the exact block to replace (the `for (const { node: bodyNode } of walkNodesArray(node.body))` loop that handles `bodyNode.type === "functionCall" && bodyNode.block`). The surrounding context provides: `nodeName` (string), `lookupScope(funcName, varName)` (returns `ScopeType | null`), and the per-node `funcArgs`/`localVarsInFunction` already populated.

- [ ] **Step 2: Replace the loop with a chain-aware resolver**

Replace the entire Phase-1 block loop (the `for (const { node: bodyNode } ... )` over `node.body` that sets block scopes) with a call to a new private method and the method itself. Add the method to the preprocessor class:

```ts
  /**
   * Resolve variable scopes inside block bodies with full lexical nesting.
   *
   * Each block in the function/node body gets a frame of declared names
   * (params → "blockArgs", let/const + implicit locals → "block"). A
   * reference resolves innermost-first across the block chain; the relative
   * distance to the owning block is recorded as `blockDepth` (0 = current
   * block). Names not owned by any block fall back to `lookupScope`
   * (node-local/global/imported) or are left unscoped for the node-body
   * pass / final imported pass.
   */
  private resolveBlockScopes(
    body: AgencyNode[],
    nodeName: string,
    lookupScope: (funcName: string, varName: string) => ScopeType | null,
  ): void {
    type Frame = { params: Set<string>; locals: Set<string> };
    const frames = new Map<BlockArgument, Frame>();

    // Outermost-first list of the block-ancestor chain for a walk result.
    const blockChain = (ancestors: WalkAncestor[]): BlockArgument[] =>
      ancestors.filter(
        (a): a is BlockArgument => (a as AgencyNode).type === "blockArgument",
      );

    const ensureFrame = (b: BlockArgument): Frame => {
      let f = frames.get(b);
      if (!f) {
        f = { params: new Set(b.params.map((p) => p.name)), locals: new Set() };
        frames.set(b, f);
      }
      return f;
    };

    // Resolve a name against a chain; returns owner scope + relative depth,
    // or null if not owned by any block in the chain.
    const resolveInChain = (
      name: string,
      chain: BlockArgument[],
    ): { scope: "block" | "blockArgs"; blockDepth: number } | null => {
      for (let i = chain.length - 1; i >= 0; i--) {
        const f = ensureFrame(chain[i]);
        const depth = chain.length - 1 - i;
        if (f.params.has(name)) return { scope: "blockArgs", blockDepth: depth };
        if (f.locals.has(name)) return { scope: "block", blockDepth: depth };
      }
      return null;
    };

    const walk = walkNodesArray(body);

    // Register every block frame (params) up front.
    for (const { ancestors } of walk) {
      for (const b of blockChain(ancestors)) ensureFrame(b);
    }

    // Pass A: let/const declarations always create a local in their own block.
    for (const { node, ancestors } of walk) {
      if (node.type !== "assignment" || !node.declKind) continue;
      const chain = blockChain(ancestors);
      if (chain.length === 0) continue; // node-body decl → Phase 2 handles it
      ensureFrame(chain[chain.length - 1]).locals.add(node.variableName);
    }

    // Pass B: implicit locals from bare assignments, shallow blocks first so
    // an inner block can see an outer block's implicit local.
    const assignments = walk
      .filter(({ node }) => node.type === "assignment" && !node.declKind)
      .map((r) => ({ ...r, chain: blockChain(r.ancestors) }))
      .filter((r) => r.chain.length > 0)
      .sort((a, b) => a.chain.length - b.chain.length);
    for (const { node, chain } of assignments) {
      const name = (node as Assignment).variableName;
      if (resolveInChain(name, chain)) continue; // existing block var
      if (lookupScope(nodeName, name) !== null) continue; // node-local/global
      ensureFrame(chain[chain.length - 1]).locals.add(name); // implicit local
    }

    // Pass C: set scope + blockDepth on every reference inside a block.
    for (const { node, ancestors } of walk) {
      const chain = blockChain(ancestors);
      if (chain.length === 0) continue; // node-body node → leave for Phase 2

      if (node.type === "assignment") {
        if (node.scope) continue;
        const owned = resolveInChain(node.variableName, chain);
        if (owned) {
          node.scope = owned.scope;
          node.blockDepth = owned.blockDepth;
        } else {
          const resolved = lookupScope(nodeName, node.variableName);
          if (resolved) node.scope = resolved; // node-local/global, no depth
          // else: left unscoped (cannot happen — implicit local added in Pass B)
        }
      } else if (node.type === "variableName") {
        if (node.scope) continue;
        const owned = resolveInChain(node.value, chain);
        if (owned) {
          node.scope = owned.scope;
          node.blockDepth = owned.blockDepth;
        } else {
          const resolved = lookupScope(nodeName, node.value);
          if (resolved) node.scope = resolved;
          // else: leave unscoped → final imported pass resolves it
        }
      }
    }
  }
```

Then, where the old Phase-1 loop was, call:
```ts
        this.resolveBlockScopes(node.body, nodeName, lookupScope);
```

Add the needed imports at the top of the file if not already present:
```ts
import type { BlockArgument } from "@/types/blockArgument.js";
import type { WalkAncestor } from "@/utils/node.js";
```
(Confirm the exact export path for `WalkAncestor` with `grep -n "WalkAncestor" lib/utils/node.ts`; it is the ancestor element type used by `walkNodes`.)

- [ ] **Step 3: Verify `blockDepth` via the AST dump**

Run:
```bash
make > make.log 2>&1
pnpm run preprocess tests/agency/blocks/nested-block-write.agency > pp-ast.json 2>&1
grep -n "blockDepth" pp-ast.json
```
Expected: the inner `y = 2` assignment carries `"blockDepth": 1`; the outer `let y = 1` and `result = y` carry depth `0`/absent. (`result` resolves to a node-local, not a block.)

- [ ] **Step 4: Run the repro, confirm it PASSES**

Run:
```bash
pnpm run agency test tests/agency/blocks/nested-block-write.agency > nested-block-write.log 2>&1; tail -20 nested-block-write.log
```
Expected: PASS — output `2`.

- [ ] **Step 5: Regression — existing block tests**

Run:
```bash
pnpm run agency test tests/agency/blocks/block-name-collision.agency > reg.log 2>&1
pnpm run agency test tests/agency/blocks/block-params.agency >> reg.log 2>&1
pnpm run agency test tests/agency/callback-block-shares-frame.agency >> reg.log 2>&1
tail -30 reg.log
```
Expected: all PASS.

- [ ] **Step 6: Clean up scratch + commit**

```bash
rm -f pp-ast.json make.log nested-block-write.log reg.log
git add lib/preprocessors/typescriptPreprocessor.ts
git commit -m "fix: nesting-aware lexical block scope resolution"
```

---

### Task 8: Coverage — shadowing, depth, interrupts, fork, handlers

Lock in the risk areas from the spec (interrupt/resume rebinding, deferred-invocation contexts, depth agreement).

**Files:**
- Create: `tests/agency/blocks/nested-block-three-level.agency` (+ `.test.json`)
- Create: `tests/agency/blocks/nested-block-shadow.agency` (+ `.test.json`)
- Create: `tests/agency/blocks/nested-block-fork.agency` (+ `.test.json`)

- [ ] **Step 1: Three-level nesting + outer param read**

`tests/agency/blocks/nested-block-three-level.agency`:
```agency
def run(b: () -> void) {
  b()
}

node main(): number {
  let total = 0
  run() as {
    let a = 1
    run() as {
      let b = 10
      run() as {
        a = a + 100      // writes outermost block's a (depth 2)
        b = b + 20       // writes middle block's b (depth 1)
      }
      total = a + b      // 101 + 30
    }
  }
  return total
}
```
`tests/agency/blocks/nested-block-three-level.test.json`:
```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "writes resolve to the correct enclosing block at depths 1 and 2",
      "input": "",
      "expectedOutput": "131",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 2: Shadowing — inner `let` is a distinct local**

`tests/agency/blocks/nested-block-shadow.agency`:
```agency
def run(b: () -> void) {
  b()
}

node main(): number {
  let outer = 0
  run() as {
    let y = 1
    run() as {
      let y = 99     // shadows: a NEW inner-block local
      y = y + 1      // touches the inner y only
    }
    outer = y        // outer block's y is still 1
  }
  return outer
}
```
`tests/agency/blocks/nested-block-shadow.test.json`:
```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "inner `let y` shadows; outer y untouched",
      "input": "",
      "expectedOutput": "1",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Nested block inside a fork branch**

The behavior under test is a nested block writing the **fork-block's own
local** (`local = local + item`, blockDepth 1). Assert on the **per-branch
returned values**, NOT a shared outer accumulator — `fork(...) as i { ... return X }`
returns an array of branch results (see `tests/agency/thread/cost-fork-join.agency`).
A shared `outer = outer + local` write would instead exercise fork branch-merge
semantics (unrelated to this change) and race.

`tests/agency/blocks/nested-block-fork.agency`:
```agency
def run(b: () -> void) {
  b()
}

node main(): string {
  let results = fork([1, 2, 3]) as item {
    let local = item
    run() as {
      local = local + item   // nested block (depth 1) writes the fork-block local
    }
    return local             // per-branch result: 2 * item
  }
  return "${results[0]}_${results[1]}_${results[2]}"
}
```
`tests/agency/blocks/nested-block-fork.test.json`:
```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "nested block writes the fork-block's own local; per-branch returns are 2*item",
      "input": "",
      "expectedOutput": "\"2_4_6\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 4: Build fixtures and run all three**

Run:
```bash
make > make.log 2>&1
for t in nested-block-three-level nested-block-shadow nested-block-fork; do
  pnpm run agency test tests/agency/blocks/$t.agency >> cov.log 2>&1
done
tail -40 cov.log
```
Expected: all PASS. If the fork case reveals branch-stack frame addressing issues, that is Risk #2 from the spec — debug `__bframe_*` capture inside `forkBlockSetup` before proceeding.

- [ ] **Step 5: Add an interrupt-crossing test (Risk #1)**

Find an existing interrupt block test for the pattern:
```bash
sed -n '1,60p' tests/agency/blocks/block-interrupt-assign-resolve.agency
cat tests/agency/blocks/block-interrupt-assign-resolve.test.json
```
Create `tests/agency/blocks/nested-block-interrupt.agency` that declares a variable in an outer block, performs an `ask`/interrupt inside a nested block, and after resume writes the outer block's variable — mirroring the existing interrupt test's `.test.json` response wiring. Use the existing test's structure verbatim for the interrupt/response fields; only the nesting differs. Expected output asserts the post-resume outer write is visible.

- [ ] **Step 6: Run the interrupt test**

Run:
```bash
pnpm run agency test tests/agency/blocks/nested-block-interrupt.agency > intr.log 2>&1; tail -30 intr.log
```
Expected: PASS — confirms `__bframe_*` is rebound to the restored frame on resume.

- [ ] **Step 7: Clean up + commit**

```bash
rm -f make.log cov.log intr.log
git add tests/agency/blocks/nested-block-*.agency tests/agency/blocks/nested-block-*.test.json tests/agency/blocks/nested-block-*.js
git commit -m "test: nested block scope coverage (depth, shadow, fork, interrupt)"
```

---

### Task 9: Regenerate fixtures and verify the diff is scoped

**Files:**
- Modify: `tests/**/*.js` (regenerated fixtures), `tests/typescriptGenerator/**` if present.

- [ ] **Step 1: Rebuild all fixtures**

Run:
```bash
make > make.log 2>&1 && make fixtures > fixtures.log 2>&1; tail -5 fixtures.log
```

- [ ] **Step 2: Review the diff**

Run:
```bash
git status --short | head -40
git diff --stat | tail -20
```
Expected changes only of two shapes: (a) a new `const __bframe_<blockName> = __bstack;` line per block setup, and (b) ancestor block references switching from `__bstack.*`/`__bstack2.*` to `__bframe_<blockName>.*`. No changes to node/function/global/static accesses, control flow, or step IDs.

- [ ] **Step 3: Spot-check a representative fixture**

Run:
```bash
git diff tests/agency/blocks/block-basic.js
```
Expected: only the added `__bframe_*` binding line (block-basic is non-nested, so no reference changes — depth-0 keeps `__bstack`).

- [ ] **Step 4: Commit**

```bash
git add -A tests/
git commit -m "chore: regenerate fixtures for __bframe block addressing"
```

- [ ] **Step 5: Full unit-test sweep**

Run:
```bash
pnpm test:run > unit.log 2>&1; tail -20 unit.log
```
Expected: PASS. (Do NOT run the full Agency suite locally — CI runs it on the PR, per CLAUDE.md.)

```bash
rm -f make.log fixtures.log unit.log
```

---

## Self-Review

**Spec coverage:**
- §1 scope representation (`blockDepth`) → Task 2. ✅
- §2 preprocessor lexical resolution → Task 7. ✅
- §3 codegen `__bframe_<blockName>` + builder resolution → Tasks 4, 5, 6. ✅
- Pretty-printer addressing → Task 3. ✅
- Risk #1 interrupt/resume → Task 8 Steps 5-6. ✅
- Risk #2 deferred-invocation (fork) → Task 8 Step 3; (handlers) — **gap addressed below.** 
- Risk #3 depth agreement (loops/if/match/handler arms) → Task 8 three-level (loop-free) + fork; partial. The `resolveBlockScopes` walk derives depth from `blockArgument` ancestors and the builder derives it from `ScopeManager` block scopes. `if`/`for`/`match` do NOT push block scopes (verified: only `functionCall.block`, `processBlockAsExpression`, and fork push `{ type: "block" }`), so a nested block inside an `if` inside a block has the same block-ancestor count on both sides. ✅ for `functionCall.block` and fork; covered behaviorally by the shadow test.

**Known limitation — standalone block expressions (`processBlockAsExpression`).** A block used as an *expression* (e.g. `.partial(block: { … })`, or a block assigned to a variable) DOES push a builder block scope, but `walkNodes` has **no `blockArgument` case** (verified in `lib/utils/node.ts`), so the preprocessor walk never descends into such a block's interior. Consequently `resolveBlockScopes` never sets `blockDepth` on references inside standalone block expressions, and the builder's `blockFrameVar(0)` falls back to `__bstack` (the innermost frame). This means a nested block *inside a standalone block expression* that references an outer-of-that-expression block variable would NOT be fixed by this work. This is **pre-existing** behavior (the preprocessor never visited those interiors), so the change introduces **no regression** there — but the depth-agreement claim is NOT full coverage. Fixing standalone block expressions would require adding a `blockArgument` descent case to `walkNodes`; tracked as out of scope here. The depth-agreement reasoning above holds specifically for blocks reached through `functionCall.block` and `fork`, which is where the reported bug lives.

**Gap fix — add a handler-body nested-block case to Task 8** (Risk #2, `with`/`handle`): append to Task 8 Step 3 a `nested-block-handler.agency` that declares an outer-block local, opens a `handle { ... } with h` (or inline handler) whose body contains a nested block that writes the outer-block local, and asserts the write is visible. Use an existing `tests/agency/` handler test for the exact `handle`/`with` syntax. Run it alongside Step 4. If handler bodies are emitted as inline nested arrows (expected), closure capture of `__bframe_*` holds; if a handler is hoisted out of the block's arrow, this test will catch it.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — each step shows concrete code or commands. The fork expected-value note and the interrupt/handler "mirror an existing test" steps are explicit instructions to copy a named existing fixture's wiring, not vague placeholders, because the interrupt/`with` response-JSON format is established by those fixtures and must match them exactly.

**Type consistency:** `blockDepth?: number` (AST) and `blockFrameVar?: string` (IR) are used consistently; `ScopeManager.blockFrameVar(depth)` returns `string | undefined`; `AssignmentEmitter` deps gain `resolveBlockFrameVar: (blockDepth: number) => string | undefined`; `scopedAssign`/`lhs`/`sliceAssign` all take `blockDepth = 0`. `ts.scopedVar(name, scope, moduleId?, blockFrameVar?)` arg order matches every call site updated in Tasks 2/3/6.
