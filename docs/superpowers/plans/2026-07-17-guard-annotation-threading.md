# Guard Annotation Threading Implementation Plan (#580)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread a guard's `Result<T>` annotation (on the assignment, or on the enclosing def's declared return for return-position guards) into the guard block's codegen, so the saveDraft tool schema and `responseFormat` inside the block use `T` instead of falling back.

**Architecture:** Three moves, one per task. (1) `guardDesugar` becomes context-aware — a walk context carries the "current return target", captured from def returns, reset at every block body — and stamps `successType` onto the `BlockArgument` it creates. (2) The builder copies the stamp onto the block scope it pushes, and the two `ScopeManager` lookups answer block-first. (3) Fixtures + sweep + PR.

**Tech Stack:** TypeScript, vitest, the Agency fixture harness.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-17-guard-annotation-threading-design.md` (on this branch, with both review rounds folded). Branch: `guard-annotation-threading`, already created from post-#578 main.
- All paths below are relative to `packages/agency-lang/`.
- Run `make` before running any Agency fixture; save test output to files (`2>&1 | tee "$TMPDIR/<name>.log"`); never run the full Agency suite locally.
- Commit messages via file + `git commit -F` (apostrophes break `-m`); end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; check `git branch --show-current` before every commit.
- Codebase rules: no dynamic imports, objects over maps, arrays over sets, `type` over `interface`, no nested ternaries, no C-style loops where `for...of`/array methods read better. `pnpm run lint:structure` before the final commit.
- `docs/site/guide/llm.md`'s block-limitation note is owner-authored — do NOT edit; list it as a doc follow-up in the PR body.

---

## Background: the load-bearing facts (read first)

**The desugar today is context-free.** `guardDesugar.ts` exports `desugarGuardsInBody(body)`; its `desugarNode` recurses through `bodySlots(node)` and follows a generic `holder.value` field with no parent-awareness and no threaded context. Both entry points (`typescriptPreprocessor.ts:331` and `typeChecker/index.ts:111`) call it on the WHOLE program, so the walk itself descends into defs. The spec's round-2 honesty note: making this context-aware is new structural work, and this plan owns it.

**`bodySlots` already tells you which slots are block bodies.** Each slot for a `functionCall`'s inline block carries `blockAncestor: BlockArgument` (`lib/utils/bodySlots.ts:41`). That is the discriminator the reset rule needs: a slot WITH `blockAncestor` is a block body (the return target resets to that block's own yield); a slot without one inherits, except `function`/`graphNode` nodes, which capture their declared `returnType`.

**Guards appear in exactly three positions** (the desugar's own doc comment): statement, `assignment.value`, `return.value`. The parser registers `guardBlockParser` at those three points, so the two stamping positions (assignment, return) plus the no-stamp statement case are exhaustive.

**The Result type is easy to unwrap.** `ResultType = { type: "resultType", successType, failureType }` (`lib/types/typeHints.ts:157`). The stamp is `successType`; `failureType` plays no role.

**The two consumers are already wired to the right lookups.** `return llm(...)` inside a block calls `this.scopes.returnType()` (`typescriptBuilder.ts:3190`) — today that answers `undefined` for blocks, and the comment at 3181-3183 documents the string fallback. The saveDraft schema calls `this.scopes.enclosingDeclaredReturnType()` (#578), which today walks PAST all blocks. Making both answer a stamped block fixes both features with zero `processLlmCall` changes.

**Why the checker needs no changes.** The checker already types these programs correctly (`synthGuardCall` infers `Result<union of block returns>` and checks assignability against the annotation). This feature is codegen-only: it carries the annotation to a place codegen can read; the checker keeps judging it.

**What the e2e fixture can and cannot pin.** The deterministic client ignores schemas, and the intrinsic saves mismatched values anyway (with a warning ack) — so no fixture OUTCOME can distinguish the threaded schema from the fallback. The fixture in Task 3 exercises the non-fallback PATH end to end (an object schema flows codegen → `draftSchema` → `buildDefinition` → provider without breaking anything); the distinguishing assertions live in the codegen tests (Task 2) and the already-merged runtime seam test (`intrinsicToolSchema.test.ts`).

## File map

| File | Change |
|---|---|
| `lib/types/blockArgument.ts` | `declaredYieldType?: VariableType` field |
| `lib/preprocessors/guardDesugar.ts` | walk context, parent-aware value follow, stamping |
| `lib/preprocessors/guardDesugar.test.ts` | stamp tests (extend existing file) |
| `lib/types.ts` (`BlockScope`, ~line 176) | `declaredYieldType?: VariableType` field |
| `lib/backends/typescriptBuilder.ts` (`processBlockArgument`, ~1775) | copy the stamp onto the pushed scope |
| `lib/backends/typescriptBuilder/scopeManager.ts` | `returnType()` + `enclosingDeclaredReturnType()` answer block-first |
| `lib/backends/draftSchemaCodegen.test.ts` | annotation-threading codegen tests (extend) |
| `tests/agency/guards/savedraft-annotated-structured.agency/.test.json` | NEW fixture |

---

### Task 1: Context-aware guard desugar with stamping

**Files:**
- Modify: `lib/types/blockArgument.ts`
- Modify: `lib/preprocessors/guardDesugar.ts`
- Test: `lib/preprocessors/guardDesugar.test.ts` (extend)

**Interfaces:**
- Consumes: `ResultType` (`successType` unwrap), `bodySlots` slot shape (`blockAncestor?: BlockArgument`).
- Produces: `BlockArgument.declaredYieldType?: VariableType` — Task 2 reads this off the AST node. `desugarGuardsInBody(body)` keeps its public signature (the context parameter defaults, so both entry points are untouched).

- [ ] **Step 1: Write the failing stamp tests**

Read `lib/preprocessors/guardDesugar.test.ts` first and reuse its parse helper (it parses source and runs `desugarGuardsInBody`). Append:

```ts
/** Find the desugared _guard call's block argument under `node`. */
function guardBlockArgOf(node: any): any {
  // Walk shallowly: tests construct one known shape each, so a direct
  // path read keeps failures readable. Adjust per test.
  throw new Error("use direct path reads in each test instead");
}

describe("guardDesugar — declaredYieldType stamping (#580)", () => {
  it("stamps successType from an annotated assignment", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: Result<string> = guard(cost: $1) {\n    return "x"\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((n: any) => n.type === "function") as any;
    const assign = def.body.find((n: any) => n.type === "assignment");
    expect(assign.value.functionName).toBe("_guard");
    expect(assign.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("stamps nothing on an unannotated assignment", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r = guard(cost: $1) {\n    return "x"\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((n: any) => n.type === "function") as any;
    const assign = def.body.find((n: any) => n.type === "assignment");
    expect(assign.value.block.declaredYieldType).toBeUndefined();
  });

  it("stamps nothing from a non-Result annotation", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: string = guard(cost: $1) {\n    return "x"\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((n: any) => n.type === "function") as any;
    const assign = def.body.find((n: any) => n.type === "assignment");
    expect(assign.value.block.declaredYieldType).toBeUndefined();
  });

  it("stamps a return-position guard from the enclosing def's declared Result return", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  return guard(cost: $1) {\n    return "x"\n  }\n}\n',
    );
    const def = nodes.find((n: any) => n.type === "function") as any;
    const ret = def.body.find((n: any) => n.type === "returnStatement");
    expect(ret.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("does NOT stamp a return-position guard inside another block (target resets)", () => {
    // The return inside the fork branch yields to the BRANCH, not to
    // f — stamping it with f's Result<string> would be the round-2
    // mis-stamp. The branch has no yield type, so: no stamp.
    const nodes = desugarSource(
      'def f(): Result<string> {\n  const r = fork([1]) as n {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n  return guard(cost: $1) { return "y" }\n}\n',
    );
    const def = nodes.find((n: any) => n.type === "function") as any;
    const forkAssign = def.body.find((n: any) => n.type === "assignment");
    const innerReturn = forkAssign.value.block.body.find(
      (n: any) => n.type === "returnStatement",
    );
    expect(innerReturn.value.block.declaredYieldType).toBeUndefined();
  });

  it("composes: a stamped guard block becomes the return target for its own body", () => {
    const nodes = desugarSource(
      'def f(): string {\n  const r: Result<Result<string>> = guard(cost: $1) {\n    return guard(cost: $1) {\n      return "x"\n    }\n  }\n  return "y"\n}\n',
    );
    const def = nodes.find((n: any) => n.type === "function") as any;
    const outer = def.body.find((n: any) => n.type === "assignment").value;
    expect(outer.block.declaredYieldType.type).toBe("resultType");
    const innerReturn = outer.block.body.find(
      (n: any) => n.type === "returnStatement",
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
    const def = nodes.find((n: any) => n.type === "function") as any;
    const assign = def.body.find((n: any) => n.type === "assignment");
    expect(assign.value.block.declaredYieldType).toEqual({
      type: "primitiveType",
      value: "number",
    });
  });

  it("a statement-position guard stamps nothing", () => {
    const nodes = desugarSource(
      'def f(): Result<string> {\n  guard(cost: $1) {\n    return "x"\n  }\n  return guard(cost: $1) { return "y" }\n}\n',
    );
    const def = nodes.find((n: any) => n.type === "function") as any;
    const stmt = def.body.find(
      (n: any) => n.type === "functionCall" && n.functionName === "_guard",
    );
    expect(stmt.block.declaredYieldType).toBeUndefined();
  });
});
```

Delete the unused `guardBlockArgOf` sketch — each test reads its path directly, as written. If the existing file's helper is named differently than `desugarSource`, use the file's actual helper; if none parses source, add one with `parseAgency(src, {}, false)` + `desugarGuardsInBody(parsed.result.nodes)`. Check the exact AST shape of `Result<string>` annotations before asserting `primitiveType` (run `pnpm run ast` on a one-liner if unsure) and adjust the expected objects to the real parser output — the assertions above are the intent, the parser's shape is the truth.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/preprocessors/guardDesugar.test.ts 2>&1 | tee "$TMPDIR/desugar-stamp.log"`
Expected: the new tests FAIL (`declaredYieldType` is undefined everywhere / field does not exist); existing tests still pass.

- [ ] **Step 3: Add the AST field**

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
   *  assignment annotation, or of the enclosing def's declared return
   *  for a return-position guard. Stamped by guardDesugar (#580);
   *  absent on every other block. Codegen reads it to type the
   *  saveDraft schema and responseFormat inside the block. */
  declaredYieldType?: VariableType;
};
```

(Fix the `VariableType` import path if `../types.js` does not export it — it does today.)

- [ ] **Step 4: Rewrite the desugar walk with context**

Replace the walk portion of `lib/preprocessors/guardDesugar.ts` (keep the module doc comment, updating its last paragraph):

```ts
import { AgencyNode, VariableType } from "@/types.js";
import { GuardBlock } from "@/types/guardBlock.js";
import { bodySlots } from "@/utils/bodySlots.js";

/** The walk context: the type a `return` statement at this point in
 *  the tree yields to. Captured from the declared return when the
 *  walk enters a def/node body; RESET at every block body (a return
 *  inside a block yields to the BLOCK) — to the block's own stamp
 *  for a just-stamped guard block, to nothing for any other block.
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
function yieldTypeFrom(t: VariableType | null | undefined): VariableType | undefined {
  if (t && t.type === "resultType") return t.successType;
  return undefined;
}

/** The context a slot's body walks under: block bodies RESET the
 *  return target to the block's own yield (undefined for non-guard
 *  blocks); def/node bodies capture the declared return; every other
 *  body inherits. */
function slotContext(
  node: AgencyNode,
  slot: { blockAncestor?: { declaredYieldType?: VariableType } },
  ctx: DesugarContext,
): DesugarContext {
  if (slot.blockAncestor) {
    return { returnTarget: slot.blockAncestor.declaredYieldType };
  }
  if (node.type === "function" || node.type === "graphNode") {
    const declared = (node as { returnType?: VariableType | null }).returnType;
    return { returnTarget: declared ?? undefined };
  }
  return ctx;
}

function desugarNode(node: AgencyNode, ctx: DesugarContext): AgencyNode {
  if (node.type === "guardBlock") {
    // Statement position: nothing to yield to, no stamp.
    return desugarGuardBlock(node as GuardBlock, undefined);
  }
  for (const slot of bodySlots(node)) {
    desugarGuardsInBody(slot.body, slotContext(node, slot, ctx));
  }
  // Parent-aware value follow (spec round 2): the two positions that
  // can stamp are handled by holder type; everything else follows the
  // generic path with no stamp source.
  const holder = node as { value?: unknown; typeHint?: VariableType | null };
  const value = holder.value;
  if (!value || typeof value !== "object" || !("type" in (value as object))) {
    return node;
  }
  const valueNode = value as AgencyNode;
  if (valueNode.type === "guardBlock") {
    let stamp: VariableType | undefined;
    if (node.type === "assignment") {
      stamp = yieldTypeFrom(holder.typeHint);
    } else if (node.type === "returnStatement") {
      stamp = yieldTypeFrom(ctx.returnTarget);
    }
    holder.value = desugarGuardBlock(valueNode as GuardBlock, stamp);
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
  const block: {
    type: "blockArgument";
    inline: boolean;
    params: never[];
    body: AgencyNode[];
    declaredYieldType?: VariableType;
  } = {
    type: "blockArgument",
    inline: false,
    params: [],
    body: [],
  };
  if (yieldType !== undefined) {
    block.declaredYieldType = yieldType;
  }
  block.body = desugarGuardsInBody(g.body, { returnTarget: yieldType });
  return {
    type: "functionCall",
    functionName: "_guard",
    arguments: g.arguments,
    block,
    scope: "imported",
    loc: g.loc,
  } as unknown as AgencyNode;
}
```

Check the real field names before finishing: the assignment annotation field (`typeHint` — verify on the `Assignment` type) and def/node return fields (`returnType` on both `FunctionDefinition` and `GraphNodeDefinition`). Adjust the casts to the actual types rather than `any` where the imports are cheap.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:run lib/preprocessors/guardDesugar.test.ts lib/typeChecker/guardConstruct.test.ts 2>&1 | tee "$TMPDIR/desugar-stamp2.log"`
Expected: PASS, including the pre-existing desugar and guard-construct suites (the checker runs the same desugar in its constructor — the context default keeps it identical for unannotated code).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit 2>&1 | tee "$TMPDIR/tsc-580-1.log"
git branch --show-current   # must be guard-annotation-threading
printf 'feat: guardDesugar stamps Result<T> annotations onto guard block arguments\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > "$TMPDIR/cm.txt"
git add packages/agency-lang/lib/types/blockArgument.ts packages/agency-lang/lib/preprocessors/guardDesugar.ts packages/agency-lang/lib/preprocessors/guardDesugar.test.ts
git commit -F "$TMPDIR/cm.txt"
```

---

### Task 2: Builder plumbing — the stamp reaches both consumers

**Files:**
- Modify: `lib/types.ts` (`BlockScope`, ~line 176)
- Modify: `lib/backends/typescriptBuilder.ts` (`processBlockArgument`, the `scopes.push({ type: "block", blockName })` at ~1775; the stale comment at ~3181)
- Modify: `lib/backends/typescriptBuilder/scopeManager.ts` (`returnType()` block case; `enclosingDeclaredReturnType()` walk)
- Test: `lib/backends/draftSchemaCodegen.test.ts` (extend)

**Interfaces:**
- Consumes: `BlockArgument.declaredYieldType` (Task 1).
- Produces: `BlockScope.declaredYieldType?: VariableType`; `returnType()` answers a stamped block's yield; `enclosingDeclaredReturnType()` walks innermost-first and returns the FIRST answer (stamped block, else nearest function/node declared return, else undefined).

- [ ] **Step 1: Write the failing codegen tests**

Append to `lib/backends/draftSchemaCodegen.test.ts` (its `gen` helper already exists):

```ts
describe("draftSchema threading — guard annotations (#580)", () => {
  it("an annotated assignment beats the enclosing def's type", () => {
    // def declares Report-ish; the guard annotation says string; the
    // schema must follow the annotation (the slot), not the def.
    const out = gen(
      'type Report = { title: string }\ndef f(): Report {\n  const notes: Result<string> = guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n  if (isSuccess(notes)) { return { title: notes.value } }\n  return { title: "x" }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toContain("draftSchema: z.string()");
    expect(out).not.toContain("draftSchema: Report");
  });

  it("a return-position guard unwraps the declared Result return", () => {
    // Today this threads the WHOLE Result shape from the def walk;
    // with the stamp it must be the unwrapped T.
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
    expect(out).not.toContain("draftSchema: Report");
  });

  it("responseFormat inside an annotated guard follows the annotation", () => {
    // A structured annotation must produce a structured responseFormat
    // for `return llm(...)` in the block — the documented limitation
    // being fixed. (A string annotation is indistinguishable from the
    // old default, which is why this test uses an object type.)
    const out = gen(
      'def f(): Result<{ title: string }> {\n  return guard(cost: $1) {\n    return llm("hi")\n  }\n}\nnode main() { const x = f()\n return "ok" }\n',
    );
    expect(out).toMatch(/responseFormat: z\.object\(/);
  });

  it("an unannotated guard keeps the old fallbacks (byte-stability spot check)", () => {
    const out = gen(
      'def f(): string {\n  const r = guard(cost: $1) {\n    return llm("hi", tools: [print])\n  }\n  if (isSuccess(r)) { return r.value }\n  return "x"\n}\nnode main() { return f() }\n',
    );
    // Falls through to the def's declared string, exactly as in #578.
    expect(out).toContain("draftSchema: z.string()");
    expect(out).not.toContain("responseFormat");
  });
});
```

Before finalizing the `responseFormat` assertion, check how `processLlmCall` renders a structured response format (`$.z().prop("object").namedArgs(...)` — see typescriptBuilder.ts:3641) and match the real emitted text (it may render as `responseFormat: z.object({ response: ... })`); the assertions are intent, the emitted shape is truth.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/backends/draftSchemaCodegen.test.ts 2>&1 | tee "$TMPDIR/580-codegen.log"`
Expected: the four new threading tests FAIL (annotation ignored, Result shape threaded, no responseFormat); the byte-stability spot check may already pass.

- [ ] **Step 3: Add the scope field and copy the stamp**

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

In `lib/backends/typescriptBuilder.ts`, `processBlockArgument` (~1775):

```ts
this.scopes.push({
  type: "block",
  blockName,
  declaredYieldType: block.declaredYieldType,
});
```

- [ ] **Step 4: Teach the two lookups**

In `lib/backends/typescriptBuilder/scopeManager.ts`, `returnType()` — replace the `case "block"` arm and trim the now-stale part of its doc comment:

```ts
      case "block":
        // Annotated guard blocks carry their yield (#580); every
        // other block still has no declared type.
        return scope.declaredYieldType ?? undefined;
```

And `enclosingDeclaredReturnType()` — the walk now takes the first ANSWER, not the first non-block scope:

```ts
  enclosingDeclaredReturnType(): VariableType | undefined {
    // Innermost-first, first answer wins: a stamped guard block
    // answers its yield; an unstamped block defers outward; the
    // nearest function/node answers its declared return; global ends
    // the walk. (Only function/node/block are ever pushed over the
    // root global — the invariant returnType()'s throwing default
    // relies on.)
    for (const scope of [...this.stack].reverse()) {
      if (scope.type === "block") {
        if (scope.declaredYieldType !== undefined) {
          return scope.declaredYieldType;
        }
        continue;
      }
      if (scope.type === "function") {
        return (
          this.compilationUnit.functionDefinitions[scope.functionName]
            ?.returnType ?? undefined
        );
      }
      if (scope.type === "node") {
        return (
          this.compilationUnit.graphNodes.find(
            (n) => n.nodeName === scope.nodeName,
          )?.returnType ?? undefined
        );
      }
      return undefined; // global
    }
    return undefined;
  }
```

(A `for...of` over a reversed copy with an early `continue` — the two-list `.find` from #578 cannot express "skip unstamped blocks but stop at stamped ones".) Also update the stale comment at `typescriptBuilder.ts:3181` ("The block's declared return type is unknown to the builder") to say annotated guard blocks are now the exception.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:run lib/backends/draftSchemaCodegen.test.ts lib/backends/ 2>&1 | tee "$TMPDIR/580-codegen2.log"`
Expected: all PASS, including the whole backends suite (the unannotated paths are unchanged).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit 2>&1 | tee "$TMPDIR/tsc-580-2.log"
git branch --show-current
printf 'feat: stamped guard yields reach draftSchema and responseFormat\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > "$TMPDIR/cm.txt"
git add packages/agency-lang/lib/types.ts packages/agency-lang/lib/backends/typescriptBuilder.ts packages/agency-lang/lib/backends/typescriptBuilder/scopeManager.ts packages/agency-lang/lib/backends/draftSchemaCodegen.test.ts
git commit -F "$TMPDIR/cm.txt"
```

---

### Task 3: Fixture, sweep, PR

**Files:**
- Create: `tests/agency/guards/savedraft-annotated-structured.agency` + `.test.json`
- No other code changes (verification + PR prep).

**Interfaces:**
- Consumes: Tasks 1 + 2.

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

(The `const report: { title: string } = llm(...)` shape keeps the checker happy: it types the llm call via the assignment annotation, so the block's inferred yield matches the guard annotation. A bare `return llm(...)` would infer string and error against `Result<{ title: string }>`.)

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

Expected: PASS. If the checker rejects the guard-block typing, read the error before touching the fixture — the annotated-llm-assignment shape above is the intended fix for exactly that class of error.

- [ ] **Step 3: Byte-stability + spot-check the #578 fixtures**

```bash
make fixtures 2>&1 | tail -2
git status --porcelain | grep -v '^??' | tee "$TMPDIR/580-churn.log"
for f in savedraft-tool-basic savedraft-tool-order finalize-binder-returns-draft; do
  pnpm run agency test tests/agency/guards/$f.agency 2>&1 | grep -c "1/1 tests passed"
done
```

Expected: no tracked-file churn; the three #578 fixtures still pass (they are all unannotated, so their generated code must be unchanged).

- [ ] **Step 4: Full unit suite, lint, anti-pattern audit**

```bash
pnpm test:run 2>&1 | tee "$TMPDIR/580-unit.log" | tail -3
pnpm run lint:structure 2>&1 | tail -2
```

Expected: clean. Then audit `git diff main...HEAD` against `docs/dev/anti-patterns.md` (the walk rewrite in Task 1 is the spot to scrutinize: no order-dependent mutable state — the context is passed, never stored on the module or the walker).

- [ ] **Step 5: As-executed spec notes, commit, PR**

Append an "As executed" section to `docs/superpowers/specs/2026-07-17-guard-annotation-threading-design.md` recording any deviations discovered during execution. Commit the fixture + spec note, then open the PR:

```bash
git branch --show-current
printf 'test: structured-annotation saveDraft fixture; as-executed spec notes\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > "$TMPDIR/cm.txt"
git add packages/agency-lang/tests/agency/guards/savedraft-annotated-structured.agency packages/agency-lang/tests/agency/guards/savedraft-annotated-structured.test.json docs/superpowers/specs/2026-07-17-guard-annotation-threading-design.md
git commit -F "$TMPDIR/cm.txt"
git push -u origin guard-annotation-threading
```

Write the PR body to a file (link issue #580 and the spec; state the deliberate behavior change — structured `responseFormat` inside annotated guard blocks — and its justification from decision 1; list the doc follow-up: llm.md's block-limitation note is owner-authored and needs its exception sentence). End with the Claude Code attribution, then `gh pr create --title "Thread guard Result<T> annotations into block codegen (#580)" --body-file ...`.

---

## Self-review notes (checked against the spec)

- **Spec coverage:** Part 2 mechanism steps 1-4 map to Tasks 1 (stamp + context + reset) and 2 (scope copy + both lookups); the walk rule is pinned by the nested codegen test and the fork-branch desugar test; failure modes (non-Result annotation, `Result<T, E>`, statement position) each have a Task 1 test; Part 3's test list maps 1:1, with the fixture's honesty note carried into the fixture comment itself; Part 4 exclusions (inferred yields, `let`-then-assign, non-guard blocks, aliases, llm.md) have no tasks, correctly.
- **Round-2 fixes honored:** the plan owns the context plumbing as structural work (Task 1 Step 4 is a rewrite, not a patch), and the return-target reset at block bodies is implemented via `slotContext`'s `blockAncestor` branch and pinned by the fork-branch test.
- **Type consistency:** `declaredYieldType?: VariableType` is the same name on `BlockArgument` (Task 1), `BlockScope` (Task 2), and both ScopeManager reads; `desugarGuardsInBody(body, ctx = {})` keeps both existing entry points source-compatible.
- **Known honesty point:** the e2e fixture cannot distinguish threaded-vs-fallback outcomes (deterministic client ignores schemas; mismatched saves are kept) — stated in the Background and in the fixture's own comment; the codegen tests are the distinguishing layer.
