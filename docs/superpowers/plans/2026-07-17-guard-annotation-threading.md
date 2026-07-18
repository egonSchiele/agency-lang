# Guard Annotation Threading Implementation Plan (#580)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread a guard's `Result<T>` annotation (on the assignment, or on the enclosing def/node's declared return for return-position guards) into the guard block's codegen, so the saveDraft tool schema uses `T` instead of the enclosing function's type.

**Architecture:** Three moves, one per task. (1) `guardDesugar` becomes context-aware — a walk context carries the "current return target", captured from def/node returns, reset at every return-retargeting boundary (`bodySlots` gains a per-slot `retargetsReturn` marker) — and stamps `successType` onto the `BlockArgument` it creates. (2) The builder copies the stamp onto the block scope, and `enclosingDeclaredReturnType()` answers block-first (a one-predicate change). (3) Fixture + sweep + PR.

**Tech Stack:** TypeScript, vitest, the Agency fixture harness.

**DESCOPED (plan review T1, owner decision):** `responseFormat` is NOT touched. The review verified no natural type-correct program exists where a responseFormat stamp changes behavior (structured `return llm(...)` fails AG2001; the compiling shape already gets responseFormat from its assignment hint; the only reachable shape — a wider-union annotation — is the type-theoretically muddy one). `ScopeManager.returnType()` stays as-is; #582 tracks the checker expected-type propagation that unblocks it.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-guard-annotation-threading-design.md` (this branch, all three review rounds folded). Branch: `guard-annotation-threading`, created from post-#578 main.
- All paths below are relative to `packages/agency-lang/`.
- Run `make` before running any Agency fixture; save test output to files (`2>&1 | tee "$TMPDIR/<name>.log"`); never run the full Agency suite locally.
- Commit messages via file + `git commit -F`; end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; check `git branch --show-current` before every commit.
- Codebase rules: no dynamic imports, objects over maps, arrays over sets, `type` over `interface`, no nested ternaries, no build-by-mutation where a literal serves, no one-line ifs, use exported types over inline structural casts. `pnpm run lint:structure` before the final commit.
- `docs/site/guide/llm.md` is owner-authored — do NOT edit; the PR body notes its responseFormat limitation stays true until #582.

---

## Background: the load-bearing facts (all verified against this worktree)

**The desugar today is context-free.** `guardDesugar.ts`'s `desugarNode` recurses through `bodySlots(node)` and follows a generic `holder.value` field with no parent-awareness. Both entry points (`typescriptPreprocessor.ts:331`, `typeChecker/index.ts:111`) call `desugarGuardsInBody` on the whole program. The context parameter defaults, so neither entry point changes.

**Three constructs retarget `return`, and only one is marked today.** A `return` yields to its innermost closure: a block argument (own function via `__block_N` lifting), an inline handler body (its own arrow — `async (i) => {...}`), and a finalize body (the `__finalize` closure). `bodySlots` currently marks only the first (`blockAncestor` on `functionCall` block slots — set for ANY block, the "inline" in its doc comment is misleading and gets fixed here). Plan-review finding 1: the reset rule must cover all three, so `BodySlot` gains `retargetsReturn?: boolean` at the single source of truth, and the rule keys on it.

**Guards appear in exactly three positions** (statement, `assignment.value`, `return.value` — the parser's three registration points), so the stamping rule is exhaustive over assignment/return holders.

**`ResultType` is `{ type: "resultType", successType, failureType }`** (`types/typeHints.ts:157`); the stamp is `successType`. There is no existing exported Result unwrap helper anywhere in `lib/` (verified), so `yieldTypeFrom` is new code, not duplication.

**The draftSchema lookup is `enclosingDeclaredReturnType()`** (#578, `scopeManager.ts`). The change to it is ONE predicate plus one switch arm — the existing `.find` structure expresses "skip unstamped blocks, stop at stamped ones" as `scope.type !== "block" || scope.declaredYieldType !== undefined` (plan review A2; do not rewrite the method).

**Three block-scope push sites exist; only one matters.** `processBlockArgument` (~1775) is the path every desugared `_guard` block takes (called from 2734/2781/2802). `processBlockAsExpression` (1829) and the fork lowering (2852) never carry a guard's block argument — deliberately unstamped.

**Absent and undefined are equivalent for the stamp field.** Every consumer reads it with `!== undefined` checks, and `JSON.stringify` (so `pnpm run ast` output and AST fixtures) drops undefined-valued keys. So the field is ALWAYS assigned (possibly undefined) — no conditional-field dance (plan review A3).

**The double run is safe but asymmetric** (plan review finding 3): run 2 finds no `guardBlock` nodes, so nothing re-stamps — but the reset rule's `blockAncestor.declaredYieldType` read returns run-1 stamps, so the runs walk with different contexts. Harmless; pinned by a stability test; noted in a comment so the read doesn't look dead on run 1.

**What the e2e fixture can and cannot pin.** The deterministic client ignores schemas and the intrinsic keeps mismatched saves, so no fixture OUTCOME distinguishes threaded-vs-fallback. The fixture exercises the non-fallback PATH; the codegen tests are the distinguishing layer — including the structured `draftSchema: z.object(...)` assertion the fixture provably cannot make (plan review finding 2/M8).

## File map

| File | Change |
|---|---|
| `lib/utils/bodySlots.ts` | `retargetsReturn?: boolean` on `BodySlot`; set on 3 slots; fix `blockAncestor` doc comment |
| `lib/types/blockArgument.ts` | `declaredYieldType?: VariableType` field |
| `lib/preprocessors/guardDesugar.ts` | walk context, `slotContext`, `stampFor`, stamping |
| `lib/preprocessors/guardDesugar.test.ts` | stamp tests (extend) |
| `lib/types.ts` (`BlockScope`) | `declaredYieldType?: VariableType` field |
| `lib/backends/typescriptBuilder.ts` (~1775) | copy the stamp onto the pushed scope |
| `lib/backends/typescriptBuilder/scopeManager.ts` | `enclosingDeclaredReturnType()` predicate + switch arm |
| `lib/backends/typescriptBuilder/scopeManager.test.ts` | direct walk unit tests (extend) |
| `lib/backends/draftSchemaCodegen.test.ts` | annotation-threading codegen tests (extend) |
| `tests/agency/guards/savedraft-annotated-structured.agency/.test.json` | NEW fixture |

---

### Task 1: Context-aware guard desugar with stamping

**Files:**
- Modify: `lib/utils/bodySlots.ts`, `lib/types/blockArgument.ts`, `lib/preprocessors/guardDesugar.ts`
- Test: `lib/preprocessors/guardDesugar.test.ts` (extend)

**Interfaces:**
- Consumes: `BodySlot` (exported, `bodySlots.ts:34`), `ResultType.successType`, `FunctionDefinition`/`GraphNodeDefinition` `.returnType`.
- Produces: `BodySlot.retargetsReturn?: boolean`; `BlockArgument.declaredYieldType?: VariableType` (Task 2 reads it); `desugarGuardsInBody(body, ctx?)` — public call sites unchanged.

- [ ] **Step 1: Write the failing stamp tests**

Read `lib/preprocessors/guardDesugar.test.ts` first; reuse its parse helper (add one if it lacks a parse-source helper: `parseAgency(src, {}, false)` then `desugarGuardsInBody(parsed.result.nodes)`). Check the real AST shape of `Result<string>` annotations with `pnpm run ast` on a one-liner before finalizing the expected objects — the assertions below are intent, the parser's shape is truth. Use `node`-style variable names, not `n`. Append:

```ts
describe("guardDesugar — declaredYieldType stamping (#580)", () => {
  it("stamps successType from an annotated const assignment (def type differs, so the source is visible)", () => {
    // def returns number; the annotation says string. Only the
    // annotation can produce the string stamp.
    const nodes = desugarSource(
      'def f(): number {\n  const r: Result<string> = guard(cost: $1) {\n    return "x"\n  }\n  return 1\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.functionName).toBe("_guard");
    expect(assign.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("stamps a `let` annotation the same way", () => {
    const nodes = desugarSource(
      'def f(): number {\n  let r: Result<string> = guard(cost: $1) {\n    return "x"\n  }\n  return 1\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("stamps nothing on an unannotated assignment", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r = guard(cost: $1) {\n    return "x"\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.block.declaredYieldType).toBeUndefined();
  });

  it("stamps nothing from a non-Result annotation", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: string = guard(cost: $1) {\n    return "x"\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.block.declaredYieldType).toBeUndefined();
  });

  it("stamps a return-position guard from the enclosing def's declared Result return", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  return guard(cost: $1) {\n    return "x"\n  }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const ret = def.body.find((node: any) => node.type === "returnStatement");
    expect(ret.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("stamps a return-position guard inside a NODE from the node's declared return", () => {
    const nodes = desugarSource(
      'node main(): Result<string> {\n  return guard(cost: $1) {\n    return "x"\n  }\n}\n',
    );
    const graphNode = nodes.find((node: any) => node.type === "graphNode") as any;
    const ret = graphNode.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(ret.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("a return-position guard inside an `if` INHERITS the def target (positive counterpart to the resets)", () => {
    const nodes = desugarSource(
      'def f(cond: boolean): Result<string> {\n  if (cond) {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n  return guard(cost: $1) { return "y" }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const ifNode = def.body.find((node: any) => node.type === "ifElse");
    const innerReturn = ifNode.thenBody.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(innerReturn.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("does NOT stamp a return-position guard inside a fork branch (block boundary resets)", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  const r = fork([1]) as n {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n  return guard(cost: $1) { return "y" }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const forkAssign = def.body.find((node: any) => node.type === "assignment");
    const innerReturn = forkAssign.value.block.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(innerReturn.value.block.declaredYieldType).toBeUndefined();
  });

  it("does NOT stamp a return-position guard inside an inline handler body (handler boundary resets)", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  handle {\n  return guard(cost: $1) { return "ok" }\n  } with (i) {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const handle = def.body.find((node: any) => node.type === "handleBlock");
    const handlerReturn = handle.handler.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(handlerReturn.value.block.declaredYieldType).toBeUndefined();
    // The guarded body itself INHERITS (a return there returns from f):
    const bodyReturn = handle.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(bodyReturn.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("does NOT stamp a return-position guard inside a finalize body (finalize boundary resets)", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  return guard(cost: $1) { return "ok" }\n\n  finalize {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const finalize = def.body.find(
      (node: any) => node.type === "finalizeBlock",
    );
    const finReturn = finalize.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(finReturn.value.block.declaredYieldType).toBeUndefined();
  });

  it("composes: a stamped guard block becomes the return target for its own body", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: Result<Result<string>> = guard(cost: $1) {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const outer = def.body.find((node: any) => node.type === "assignment").value;
    expect(outer.block.declaredYieldType.type).toBe("resultType");
    const innerReturn = outer.block.body.find(
      (node: any) => node.type === "returnStatement",
    );
    expect(innerReturn.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("unwraps only successType from Result<T, E>", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: Result<number, string> = guard(cost: $1) {\n    return 1\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const assign = def.body.find((node: any) => node.type === "assignment");
    expect(assign.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "number",
    });
  });

  it("a statement-position guard stamps nothing", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  guard(cost: $1) {\n    return "x"\n  }\n  return guard(cost: $1) { return "y" }\n}\n',
    );
    const def = nodes.find((node: any) => node.type === "function") as any;
    const stmt = def.body.find(
      (node: any) =>
        node.type === "functionCall" && node.functionName === "_guard",
    );
    expect(stmt.block.declaredYieldType).toBeUndefined();
  });

  it("a second desugar run leaves the stamps unchanged (double-run stability)", () => {
    const nodes = desugarSource(
      'def f(): number {\n  const r: Result<string> = guard(cost: $1) {\n    return "x"\n  }\n  return 1\n}\n',
    );
    const before = JSON.stringify(nodes);
    desugarGuardsInBody(nodes as any);
    expect(JSON.stringify(nodes)).toBe(before);
  });
});
```

If the handler/finalize sources trip unrelated checker-free parse constraints (e.g. finalize needing a non-node scope — it is in a def here, fine), adjust the surrounding shell, not the assertion.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/preprocessors/guardDesugar.test.ts 2>&1 | tee "$TMPDIR/desugar-stamp.log"`
Expected: the new tests FAIL; existing tests still pass.

- [ ] **Step 3: Mark the retargeting slots and add the AST field**

In `lib/utils/bodySlots.ts`: add to the exported `BodySlot` type:

```ts
  /** True when a `return` inside this slot's body yields to the slot's
   *  own closure rather than the enclosing def: block arguments (the
   *  __block_N lifting), inline handler bodies (their own arrow), and
   *  finalize bodies (the __finalize closure). guardDesugar's return-
   *  target rule keys on this — a new return-retargeting construct
   *  must set it here or that feature silently mis-stamps. */
  retargetsReturn?: boolean;
```

Set `retargetsReturn: true` on three slots: the `functionCall` block slot (the one that carries `blockAncestor`), the inline-handler slot in `case "handleBlock"` (the `n.handler.body` slot ONLY — `n.body` inherits), and the `case "finalizeBlock"` slot. While there, fix `blockAncestor`'s doc comment: it says "inline `block:` argument" but the code sets it for ANY block; change to "the functionCall's `block:` argument (inline or not)".

In `lib/types/blockArgument.ts`:

```ts
import { AgencyNode, VariableType } from "../types.js";
import { BaseNode } from "./base.js";
import { FunctionParameter } from "./function.js";

export type BlockArgument = BaseNode & {
  type: "blockArgument";
  params: FunctionParameter[];
  body: AgencyNode[];
  inline?: boolean;
  /** The block's declared yield type, when the user wrote it adjacent
   *  to the guard this block belongs to: the `T` of a `Result<T>`
   *  assignment annotation, or of the enclosing def/node's declared
   *  return for a return-position guard. Stamped by guardDesugar
   *  (#580); undefined on every other block. Codegen reads it to type
   *  the saveDraft schema inside the block. */
  declaredYieldType?: VariableType;
};
```

- [ ] **Step 4: Rewrite the desugar walk with context**

Replace the walk portion of `lib/preprocessors/guardDesugar.ts` (keep the module doc comment; update its final paragraph to mention the context). Note the shapes deliberately chosen per the review: `slotContext` and `stampFor` are the feature's two rules as pure functions; `desugarGuardBlock` stays a single literal (the optional field is ALWAYS assigned — absent and undefined are equivalent here, and `JSON.stringify` drops undefined keys so AST output is unchanged); `slot` is typed with the exported `BodySlot`.

```ts
import { AgencyNode, VariableType } from "@/types.js";
import { Assignment } from "@/types.js";
import { FunctionDefinition } from "@/types/function.js";
import { GraphNodeDefinition } from "@/types/graphNode.js";
import { GuardBlock } from "@/types/guardBlock.js";
import { bodySlots, BodySlot } from "@/utils/bodySlots.js";

/** The walk context: the type a `return` statement at this point in
 *  the tree yields to. Captured from the declared return when the
 *  walk enters a def/node body; RESET at every return-retargeting
 *  slot (block arguments, inline handler bodies, finalize bodies —
 *  marked by BodySlot.retargetsReturn) to that slot's own yield: the
 *  stamp a guard block just received, nothing for any other closure.
 *  Absent at top level. */
type DesugarContext = {
  returnTarget?: VariableType;
};

export function desugarGuardsInBody(
  body: AgencyNode[],
  ctx: DesugarContext = {},
): AgencyNode[] {
  body.forEach((node, i) => {
    body[i] = desugarNode(node, ctx);
  });
  return body;
}

/** `successType` of a Result annotation; undefined for anything else.
 *  The desugar never validates — a non-Result annotation simply
 *  stamps nothing, and the checker owns diagnosing it. */
function yieldTypeFrom(
  t: VariableType | null | undefined,
): VariableType | undefined {
  if (t && t.type === "resultType") {
    return t.successType;
  }
  return undefined;
}

/** The context a slot's body walks under: return-retargeting slots
 *  RESET the target to the slot's own yield (a guard block's stamp;
 *  nothing for handlers/finalizes/other blocks — on the second
 *  desugar run the blockAncestor read returns run-1 stamps, which is
 *  when it earns its keep); def/node bodies capture the declared
 *  return; every other body inherits. */
function slotContext(
  node: AgencyNode,
  slot: BodySlot,
  ctx: DesugarContext,
): DesugarContext {
  if (slot.retargetsReturn) {
    return { returnTarget: slot.blockAncestor?.declaredYieldType };
  }
  if (node.type === "function" || node.type === "graphNode") {
    const def = node as FunctionDefinition | GraphNodeDefinition;
    return { returnTarget: def.returnType ?? undefined };
  }
  return ctx;
}

/** The type a guard sitting in this node's `value` slot is stamped
 *  with: an assignment names its own slot; a return yields to the
 *  current return target; anything else stamps nothing. */
function stampFor(
  node: AgencyNode,
  ctx: DesugarContext,
): VariableType | undefined {
  if (node.type === "assignment") {
    return yieldTypeFrom((node as Assignment).typeHint);
  }
  if (node.type === "returnStatement") {
    return yieldTypeFrom(ctx.returnTarget);
  }
  return undefined;
}

function desugarNode(node: AgencyNode, ctx: DesugarContext): AgencyNode {
  if (node.type === "guardBlock") {
    // Statement position: nothing to yield to, no stamp.
    return desugarGuardBlock(node as GuardBlock, undefined);
  }
  for (const slot of bodySlots(node)) {
    desugarGuardsInBody(slot.body, slotContext(node, slot, ctx));
  }
  const holder = node as { value?: unknown };
  const value = holder.value;
  if (!value || typeof value !== "object" || !("type" in (value as object))) {
    return node;
  }
  const valueNode = value as AgencyNode;
  if (valueNode.type === "guardBlock") {
    holder.value = desugarGuardBlock(
      valueNode as GuardBlock,
      stampFor(node, ctx),
    );
    return node;
  }
  const rewritten = desugarNode(valueNode, ctx);
  if (rewritten !== valueNode) {
    holder.value = rewritten;
  }
  return node;
}

function desugarGuardBlock(
  g: GuardBlock,
  yieldType: VariableType | undefined,
): AgencyNode {
  // The head arguments forward VERBATIM (unchanged from #574). The
  // stamp, when present, becomes the return target for the block's
  // own body — which is how nested return-position guards compose.
  // declaredYieldType is always assigned: absent and undefined are
  // equivalent for every consumer, and JSON.stringify drops undefined
  // keys, so AST output for unstamped guards is unchanged.
  return {
    type: "functionCall",
    functionName: "_guard",
    arguments: g.arguments,
    block: {
      type: "blockArgument",
      inline: false,
      params: [],
      declaredYieldType: yieldType,
      body: desugarGuardsInBody(g.body, { returnTarget: yieldType }),
    },
    scope: "imported",
    loc: g.loc,
  } as unknown as AgencyNode;
}
```

Verify `Assignment` is exported from `@/types.js` (it is — `types.ts:221`) and adjust imports if the real paths differ.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:run lib/preprocessors/guardDesugar.test.ts lib/typeChecker/guardConstruct.test.ts 2>&1 | tee "$TMPDIR/desugar-stamp2.log"`
Expected: PASS, including the pre-existing suites.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit 2>&1 | tee "$TMPDIR/tsc-580-1.log"
git branch --show-current   # must be guard-annotation-threading
printf 'feat: guardDesugar stamps Result annotations onto guard block arguments\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > "$TMPDIR/cm.txt"
git add packages/agency-lang/lib/utils/bodySlots.ts packages/agency-lang/lib/types/blockArgument.ts packages/agency-lang/lib/preprocessors/guardDesugar.ts packages/agency-lang/lib/preprocessors/guardDesugar.test.ts
git commit -F "$TMPDIR/cm.txt"
```

---

### Task 2: The stamp reaches the draftSchema lookup

**Files:**
- Modify: `lib/types.ts` (`BlockScope`), `lib/backends/typescriptBuilder.ts` (~1775), `lib/backends/typescriptBuilder/scopeManager.ts`
- Test: `lib/backends/typescriptBuilder/scopeManager.test.ts` (extend), `lib/backends/draftSchemaCodegen.test.ts` (extend)

**Interfaces:**
- Consumes: `BlockArgument.declaredYieldType` (Task 1).
- Produces: `BlockScope.declaredYieldType?: VariableType`; `enclosingDeclaredReturnType()` returns a stamped block's yield before walking outward. `returnType()` is NOT touched (descope).

- [ ] **Step 1: Write the failing ScopeManager unit tests**

Read `lib/backends/typescriptBuilder/scopeManager.test.ts` and reuse its construction pattern (it builds a `ScopeManager` and pushes scopes directly). Append — adjusting the constructor/compilationUnit stub to the file's existing idiom:

```ts
describe("enclosingDeclaredReturnType — stamped blocks (#580)", () => {
  const STR = { type: "primitiveType", value: "string" } as any;

  it("a stamped block answers its yield", () => {
    const scopes = makeScopeManagerWithFunction("f", /* returnType */ undefined);
    scopes.push({ type: "block", blockName: "b1", declaredYieldType: STR });
    expect(scopes.enclosingDeclaredReturnType()).toEqual(STR);
  });

  it("an unstamped block defers to a stamped outer block", () => {
    const scopes = makeScopeManagerWithFunction("f", undefined);
    scopes.push({ type: "block", blockName: "outer", declaredYieldType: STR });
    scopes.push({ type: "block", blockName: "inner" });
    expect(scopes.enclosingDeclaredReturnType()).toEqual(STR);
  });

  it("an unstamped block defers to the function's declared return", () => {
    const scopes = makeScopeManagerWithFunction("f", STR);
    scopes.push({ type: "block", blockName: "b1" });
    expect(scopes.enclosingDeclaredReturnType()).toEqual(STR);
  });

  it("a stamped block under a node answers the stamp, not the node", () => {
    const scopes = makeScopeManagerWithNode("main", /* returnType */ { type: "primitiveType", value: "number" } as any);
    scopes.push({ type: "block", blockName: "b1", declaredYieldType: STR });
    expect(scopes.enclosingDeclaredReturnType()).toEqual(STR);
  });
});
```

Write the two `makeScopeManagerWith...` helpers against the file's real `CompilationUnit` stubbing (or reuse its existing fixtures) — the tests' point is the walk order, not the stub shape.

- [ ] **Step 2: Write the failing codegen tests**

Append to `lib/backends/draftSchemaCodegen.test.ts`:

```ts
describe("draftSchema threading — guard annotations (#580)", () => {
  it("an annotated assignment beats the enclosing def's type", () => {
    const out = gen(
      'type Report = { title: string }\ndef f(): Report {\n  const notes: Result<string> = guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n  if (isSuccess(notes)) { return { title: notes.value } }\n  return { title: "x" }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
    // The fallback would render the def's Report as an object schema.
    expect(out).not.toMatch(/draftSchema: z\.object\(/);
    expect(out).not.toContain("draftSchema: Report");
  });

  it("a return-position guard unwraps the declared Result return", () => {
    // Pre-change this call site threads the WHOLE Result-shaped zod;
    // z.string() can only appear if the unwrap works.
    const out = gen(
      'def f(): Result<string> {\n  return guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
  });

  it("nested: an unannotated inner guard defers to the outer stamp", () => {
    const out = gen(
      'type Report = { title: string }\ndef f(): Report {\n  const outer: Result<string> = guard(cost: $1) {\n    const inner = guard(cost: $0.1) {\n      return llm("hi", tools: [print])\n    }\n    if (isSuccess(inner)) { return inner.value }\n    return "x"\n  }\n  return { title: "x" }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
    expect(out).not.toMatch(/draftSchema: z\.object\(/);
  });

  it("a structured annotation threads an OBJECT draftSchema (the assertion no fixture can make)", () => {
    // The llm result binds through an annotated local so the checker
    // accepts the block yield (a bare `return llm()` infers string
    // and errors against Result<{title}> — see #582).
    const out = gen(
      'def f(): string {\n  const r: Result<{ title: string }> = guard(cost: $1) {\n    const report: { title: string } = llm("hi", tools: [print])\n    return report\n  }\n  return "y"\n}\nnode main() { return f() }\n',
    );
    expect(out).toMatch(/draftSchema: z\.object\(/);
  });

  it("an unannotated guard keeps the #578 fallbacks (byte-stability spot check)", () => {
    const out = gen(
      'def f(): string {\n  const r = guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n  if (isSuccess(r)) { return r.value }\n  return "x"\n}\nnode main() { return f() }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test:run lib/backends/typescriptBuilder/scopeManager.test.ts lib/backends/draftSchemaCodegen.test.ts 2>&1 | tee "$TMPDIR/580-codegen.log"`
Expected: the new tests FAIL (`declaredYieldType` unknown on `BlockScope`; walk ignores stamps; return-position threads the Result shape).

- [ ] **Step 4: Implement — one field, one copy, one predicate, one switch arm**

In `lib/types.ts`:

```ts
export type BlockScope = {
  type: "block";
  blockName: string;
  /** The block's declared yield type, copied from the stamped
   *  BlockArgument (#580) when the builder pushes this scope. */
  declaredYieldType?: VariableType;
};
```

In `lib/backends/typescriptBuilder.ts`, `processBlockArgument` (~1775) — the ONLY push site guards reach (`processBlockAsExpression` at 1829 and the fork lowering at 2852 never carry a guard's block argument; leave them):

```ts
    this.scopes.push({
      type: "block",
      blockName,
      declaredYieldType: block.declaredYieldType,
    });
```

In `lib/backends/typescriptBuilder/scopeManager.ts`, `enclosingDeclaredReturnType()` — keep the method's existing structure (plan review A2: the diff is one predicate and one switch arm, not a rewrite):

```ts
    // Innermost-first: the nearest scope with an ANSWER — a stamped
    // guard block (#580), else the nearest non-block scope.
    const owner = [...this.stack]
      .reverse()
      .find(
        (scope) =>
          scope.type !== "block" || scope.declaredYieldType !== undefined,
      );
    if (owner === undefined) return undefined;
    switch (owner.type) {
      case "block":
        return owner.declaredYieldType;
      case "function":
        ...existing arm unchanged...
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:run lib/backends/ 2>&1 | tee "$TMPDIR/580-codegen2.log"`
Expected: all PASS (the unannotated paths are unchanged, so the whole backends suite stays green).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit 2>&1 | tee "$TMPDIR/tsc-580-2.log"
git branch --show-current
printf 'feat: stamped guard yields reach the saveDraft draftSchema lookup\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > "$TMPDIR/cm.txt"
git add packages/agency-lang/lib/types.ts packages/agency-lang/lib/backends/typescriptBuilder.ts packages/agency-lang/lib/backends/typescriptBuilder/scopeManager.ts packages/agency-lang/lib/backends/typescriptBuilder/scopeManager.test.ts packages/agency-lang/lib/backends/draftSchemaCodegen.test.ts
git commit -F "$TMPDIR/cm.txt"
```

---

### Task 3: Fixture, sweep, PR

**Files:**
- Create: `tests/agency/guards/savedraft-annotated-structured.agency` + `.test.json`

- [ ] **Step 1: Write the fixture**

`tests/agency/guards/savedraft-annotated-structured.agency`:

```
// An annotated guard threads a STRUCTURED saveDraft schema — the
// first e2e through the non-fallback path. Note what this pins and
// what it cannot: the deterministic client ignores schemas and the
// intrinsic keeps mismatched saves, so the OUTCOME here would be the
// same under the string fallback; the codegen tests own the
// distinguishing assertions. This fixture proves the threaded object
// schema flows codegen -> draftSchema -> provider without breaking
// the round-trip, and that a structured draft salvages intact.
node main() {
  const r: Result<{ title: string }> = guard(cost: 0.000001) {
    const report: { title: string } = llm("work", tools: [saveDraft])
    return report
  }
  if (isFailure(r)) { return "no-draft" }
  return r.value.title
}
```

(The annotated-local shape keeps the checker happy — a bare `return llm(...)` infers string and errors against `Result<{ title: string }>`; see #582.)

`tests/agency/guards/savedraft-annotated-structured.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"t\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [{ "name": "saveDraft", "args": { "value": { "title": "t" } } }] },
        { "return": "never-reached" }
      ],
      "description": "A structured draft saved against an annotated Result<{title}> guard salvages intact; exercises the threaded (non-fallback) schema path end to end.",
      "interruptHandlers": [{ "action": "reject" }]
    }
  ]
}
```

- [ ] **Step 2: Build and run it**

```bash
make 2>&1 | tail -1
pnpm run agency test tests/agency/guards/savedraft-annotated-structured.agency 2>&1 | tee "$TMPDIR/fx-580.log"
```

Expected: PASS.

- [ ] **Step 3: Byte-stability + spot-check the #578 fixtures**

```bash
make fixtures 2>&1 | tail -2
git status --porcelain | grep -v '^??' | tee "$TMPDIR/580-churn.log"
for f in savedraft-tool-basic savedraft-tool-order finalize-binder-returns-draft; do
  pnpm run agency test tests/agency/guards/$f.agency 2>&1 | grep -c "1/1 tests passed"
done
```

Expected: no tracked-file churn; the three #578 fixtures still pass (all unannotated, so their generated code must be unchanged).

- [ ] **Step 4: Full unit suite, lint, anti-pattern audit**

```bash
pnpm test:run 2>&1 | tee "$TMPDIR/580-unit.log" | tail -3
pnpm run lint:structure 2>&1 | tail -2
```

Then audit `git diff main...HEAD` against `docs/dev/anti-patterns.md` (the review's A-findings are already folded into the drafted code; verify the executed code kept them).

- [ ] **Step 5: As-executed spec notes, commit, PR**

Append an "As executed" section to the spec recording deviations. Commit, push, and open the PR. The PR body must: link #580 and #582 and the spec; state the DESCOPE plainly (draftSchema only; responseFormat proved unreachable in natural type-correct programs, blocked on checker expected-type propagation — #582 — which will consume the same stamp); note llm.md's limitation note stays true until #582; end with the Claude Code attribution.

---

## Self-review notes

- **All three review layers folded:** finding 1 → `retargetsReturn` at the `bodySlots` source of truth + handler/finalize/fork no-stamp tests + inherit-branch and graphNode positives (M3/M4/M5); finding 2/M8 → the structured `z.object` draftSchema assertion; finding 3/M6 → double-run test + the run-2 comment; finding 4 → push-site sentence in Task 2 Step 4; finding 5/T2/T3/T4 → sketch deleted, negatives rewritten to the shape the fallback actually emits, discriminating def types, whole-file responseFormat scan gone (with the descope); M1 → direct ScopeManager tests; M2 → moot (returnType untouched); M7 → the `let` test. A1 → `stampFor`; A2 → predicate + arm, no rewrite; A3 → single literal, always-assigned field; A4 → `BodySlot`/`FunctionDefinition`/`GraphNodeDefinition` types; A5 → braced; A6 → moot.
- **T1 resolved by owner decision:** responseFormat descoped; #582 filed; spec decision 1 rewritten; `returnType()` untouched, which also moots M2/A6 and shrinks Task 2 to one field + one copy + one predicate + one arm.
