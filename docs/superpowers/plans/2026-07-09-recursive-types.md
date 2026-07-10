# Recursive Type Aliases Fix Implementation Plan (#470 + #473) — rev 2 (review applied)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (owner preference: inline execution in the main session, NOT subagent-driven). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recursive and forward-referencing type aliases work: fix the `isAssignable` stack overflow with coinduction, fix the module-load TDZ crashes with lazy references (zod schema consts AND validation descriptors), and land the canonical `typeKey()` (#473) the coinduction keys build on.

**Architecture:** Four mechanisms. (1) `typeKey(t, aliases)` — one canonical structural-identity function replacing raw `JSON.stringify` at the dedup sites. (2) Coinductive assignability — an in-progress pair stack in a private `isAssignableGuarded` helper (public `isAssignable` keeps its three-arg signature, mirroring the `resolveType`/`resolveTypeWithGuard` split); re-encountering an in-flight pair returns true, entries removed on exit. (3) Lazy-if-not-yet-emitted zod refs — when an alias schema const initializer references a same-module plain alias whose const has not been emitted yet, emit `z.lazy(() => Name)`; pending-ness is DERIVED from the module's declaration order (no mutable emitted-set — review finding A). (4) Lazy validation-descriptor refs — a new `{ kind: "ref", get }` descriptor node defers the `__agency_descriptor` read to walk time, fixing both the forward-ref TDZ and the silent self-ref validator loss (review must-fix 1).

**Verified facts** (plan author + independent reviewer both checked these against code):
- `isAssignable` (`lib/typeChecker/assignability.ts:363`) has ~17 internal recursive call sites (lines 419–698); each resolves aliases with a fresh guard — the stack-overflow mechanism. Cycles can only arise through NAMED references (`typeAliasVariable`/`genericType`), so gating the pair guard on named nodes cannot miss a cycle.
- Alias schema consts emit in source order (`typescriptBuilder.ts:782`); bare alias-name emission at the `return variableType.aliasName;` site in `typeToZodSchema.ts`. `deepResolveNode` never inlines non-generic aliases, so the codegen bug is purely initializer ordering. PROBE-CONFIRMED: plain forward refs (`type A = { b: B }` before `B`) TDZ-crash today too.
- VALIDATED aliases emit a second module-load structure: `(Alias as any).__agency_descriptor = ...` (`typescriptBuilder.ts:802-807`). Two eager reference sites inside `validationDescriptor.ts`: the nested alias-ref read (`(Alias as any).__agency_descriptor`, ~line 296) — TDZ for forward refs, silently `undefined` for self-refs (validators vanish) — and `schemaNode`'s direct `mapTypeToValidationSchema` call (~line 173) which embeds bare alias names.
- The runtime walker (`lib/runtime/validateChain.ts`) consumes a plain `TypeValidationDescriptor` union (leaf/object/array/union/nullable) and already enforces `maxDepth` (default 64) — recursion-safe by design; a `ref` thunk kind slots in cleanly.
- zod is `^4.3.5` (zod 4): the structured-output probe should go straight to `z.toJSONSchema`, which handles cycles via `$ref`. Generated `.mjs` is transpiled, not type-checked, so `z.infer` circularity degradation is invisible at runtime.
- Only PLAIN top-level aliases emit schema consts. Generic aliases and value-param aliases never reach the const path (inlined / factory calls / stubs), and function-body aliases (`hoistBodyTypeAliases`, `typescriptBuilder.ts:686-697`) initialize at call time, not module load. The pending-names list must therefore be: top-level `typeAlias` nodes with neither `typeParams` nor `valueParams`.
- The builder is instantiated per module, and node-body `schema(...)` sites execute after module load — they never need lazy wrapping.
- The runtime validation walker depth cap means no walker-termination work is needed.

**Known scope-outs (say these in the PR):**
- `lib/typeChecker/inference.ts:162` (`unionTypes`) keeps `JSON.stringify` — its signature has no alias table and migrating ripples to callers. Noted on #473 as a residual.
- Recursive VALUE-PARAM aliases (`type Weird(n: number) = { next: Weird(n) }`) would hang codegen (`mapTypeToSchemaInner` inlines instantiations with no seen-guard) — pre-existing, out of scope, file a follow-up issue from the PR.
- The zod mapper's parameter threading is nearing sprawl (six positionals after this PR); note in the PR that the next parameter should trigger an options-object consolidation (review finding D).

## Global Constraints

- Fresh worktree: `git worktree add .claude/worktrees/recursive-types -b recursive-types`, then `cd .claude/worktrees/recursive-types && pnpm install && cd packages/agency-lang && make`.
- Never commit to `main`. No apostrophes in commit-message command lines. Save test output to files. Run `make` before CLI-based steps. Do NOT run the full agency suite locally.
- The coinduction guard must live in a PRIVATE helper (`isAssignableGuarded`); the exported `isAssignable` keeps exactly three parameters (review finding B).
- The guard must REMOVE pairs on exit (try/finally) — the Task 2 union-order test exists specifically to catch a memoizing implementation.
- Codegen pending-ness must be DERIVED (pure function of declaration order), never a mutable emitted-set (review finding A).
- Zero churn in EXISTING `tests/typescriptGenerator` fixtures is a hard gate for the zod-schema path (Task 3). Descriptor-emission churn (Task 4) is EXPECTED and deliberate — review each diff, don't block on it.

---

### Task 1: `typeKey()` — canonical structural type identity (#473)

**Files:**
- Create: `lib/typeChecker/typeKey.ts`
- Test: `lib/typeChecker/typeKey.test.ts`
- Modify: `lib/typeChecker/flow.ts` (`uniteTypes`, `widenAtLoopBackEdge`)
- Modify: `lib/typeChecker/synthesizer.ts` (`synthLogical` ~460, `synthArray` ~639, `synthObject` ~711, block return-type dedup ~1215)

**Interfaces:**
- Produces: `typeKey(t: VariableType, aliases: Record<string, TypeAliasEntry>): string`. Canonical rules (each is a deliberate, documented identity decision): top node resolved ONE step via `safeResolveType` (recursive self-refs stay nominal); nested alias refs key nominally (`alias:Name`); object properties sorted; union members sorted by canonical form; `valueArgs` INCLUDED (review must-fix 2 — `Age(18)` must not key equal to `Age(21)`); `tags`, `trivia`, `description`, `loc`, `isEffectSet`, and `blockType.raises` STRIPPED.

- [ ] **Step 1: Write the failing tests**

Create `lib/typeChecker/typeKey.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { typeKey } from "./typeKey.js";
import type { VariableType, TypeAliasEntry } from "../types.js";

const STR: VariableType = { type: "primitiveType", value: "string" };
const NUM: VariableType = { type: "primitiveType", value: "number" };
const NO_ALIASES: Record<string, TypeAliasEntry> = {};

function treeAliases(name: string): Record<string, TypeAliasEntry> {
  return {
    [name]: {
      body: {
        type: "objectType",
        properties: [
          { key: "value", value: NUM },
          {
            key: "children",
            value: {
              type: "arrayType",
              elementType: { type: "typeAliasVariable", aliasName: name },
            },
          },
        ],
      },
    },
  };
}

describe("typeKey", () => {
  it("is property-order insensitive", () => {
    const ab: VariableType = {
      type: "objectType",
      properties: [
        { key: "a", value: STR },
        { key: "b", value: NUM },
      ],
    };
    const ba: VariableType = {
      type: "objectType",
      properties: [
        { key: "b", value: NUM },
        { key: "a", value: STR },
      ],
    };
    expect(typeKey(ab, NO_ALIASES)).toBe(typeKey(ba, NO_ALIASES));
  });

  it("is union-member-order insensitive", () => {
    const ab: VariableType = { type: "unionType", types: [STR, NUM] };
    const ba: VariableType = { type: "unionType", types: [NUM, STR] };
    expect(typeKey(ab, NO_ALIASES)).toBe(typeKey(ba, NO_ALIASES));
  });

  it("ignores tags, trivia, descriptions, and effect-set flags", () => {
    const plainObj: VariableType = {
      type: "objectType",
      properties: [{ key: "a", value: STR }],
    };
    const decoratedObj: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "a",
          value: {
            type: "primitiveType",
            value: "string",
            tags: [{ type: "tag", name: "validate", arguments: [] }],
          },
          description: "described",
        },
      ],
      trivia: [{ anchorIndex: 0, comments: [] }],
    };
    expect(typeKey(decoratedObj, NO_ALIASES)).toBe(typeKey(plainObj, NO_ALIASES));
    const union: VariableType = { type: "unionType", types: [STR, NUM] };
    const effectUnion: VariableType = {
      type: "unionType",
      types: [STR, NUM],
      isEffectSet: true,
    };
    expect(typeKey(effectUnion, NO_ALIASES)).toBe(typeKey(union, NO_ALIASES));
  });

  it("resolves a top-level alias one step so alias and body key equal", () => {
    const aliases: Record<string, TypeAliasEntry> = { Age: { body: NUM } };
    const ref: VariableType = { type: "typeAliasVariable", aliasName: "Age" };
    expect(typeKey(ref, aliases)).toBe(typeKey(NUM, aliases));
  });

  it("keeps NESTED alias refs nominal: {a: AgeRef} differs from {a: number}", () => {
    const aliases: Record<string, TypeAliasEntry> = { Age: { body: NUM } };
    const nominal: VariableType = {
      type: "objectType",
      properties: [{ key: "a", value: { type: "typeAliasVariable", aliasName: "Age" } }],
    };
    const structural: VariableType = {
      type: "objectType",
      properties: [{ key: "a", value: NUM }],
    };
    expect(typeKey(nominal, aliases)).not.toBe(typeKey(structural, aliases));
  });

  it("keys a recursive alias without looping, and DIFFERENT recursive aliases key differently", () => {
    const aliases = { ...treeAliases("Tree"), ...treeAliases("Tree2") };
    const tree: VariableType = { type: "typeAliasVariable", aliasName: "Tree" };
    const tree2: VariableType = { type: "typeAliasVariable", aliasName: "Tree2" };
    // Same shape, different names: inner refs are nominal, so keys differ.
    expect(typeKey(tree, aliases)).not.toBe(typeKey(tree2, aliases));
  });

  it("distinguishes value-param instantiations (valueArgs are identity)", () => {
    const age18: VariableType = {
      type: "typeAliasVariable",
      aliasName: "Age",
      valueArgs: [{ type: "number", value: 18 }],
    };
    const age21: VariableType = {
      type: "typeAliasVariable",
      aliasName: "Age",
      valueArgs: [{ type: "number", value: 21 }],
    };
    // Unknown alias — stays nominal; the valueArgs must still distinguish.
    expect(typeKey(age18, NO_ALIASES)).not.toBe(typeKey(age21, NO_ALIASES));
  });

  it("distinguishes genuinely different types", () => {
    expect(typeKey(STR, NO_ALIASES)).not.toBe(typeKey(NUM, NO_ALIASES));
    const arr: VariableType = { type: "arrayType", elementType: STR };
    expect(typeKey(arr, NO_ALIASES)).not.toBe(typeKey(STR, NO_ALIASES));
  });
});
```

NOTE: check the number-literal expression shape before running — `{ type: "number", value: 18 }` must match the parser's number node (`lib/types/literals.ts`); adjust the two `valueArgs` literals if the field name differs.

- [ ] **Step 2: Run to verify red**

```bash
pnpm test:run lib/typeChecker/typeKey.test.ts > /tmp/rec-task1-red.log 2>&1; tail -3 /tmp/rec-task1-red.log
```

Expected: FAIL — cannot find module `./typeKey.js`.

- [ ] **Step 3: Implement**

Create `lib/typeChecker/typeKey.ts`:

```ts
import type { Expression, TypeAliasEntry, VariableType } from "../types.js";
import { safeResolveType } from "./assignability.js";

/**
 * Canonical structural identity for a type — THE replacement for raw
 * `JSON.stringify(t)` at identity sites (uniteTypes, loop widening, union
 * dedup in synthesis, coinduction pair keys). Fixes the gaps raw stringify
 * had (issue #473): property-order sensitivity, non-semantic metadata
 * leaking into the key, and unresolved top-level aliases keying
 * differently from their bodies.
 *
 * Deliberate identity decisions (all safe because the consumers feed
 * dedup/diagnostics and cycle detection, never codegen schemas):
 * - The TOP node resolves ONE step via safeResolveType (recursive
 *   self-refs stay nominal via its guard); NESTED alias refs key
 *   nominally as `alias:Name` — never expanded, so recursion terminates
 *   and same-name refs always key equal.
 * - `valueArgs` ARE identity: `Age(18)` and `Age(21)` are different types.
 * - `tags`, `trivia`, property `description`s, `loc`, `isEffectSet`, and
 *   `blockType.raises` are NOT identity: two types differing only in
 *   annotations/formatting dedup together (first member's metadata wins
 *   at union joins — acceptable for diagnostics).
 * - Union members sort by canonical form (`A | B` keys equal `B | A`);
 *   object properties sort by key.
 */
export function typeKey(
  t: VariableType,
  aliases: Record<string, TypeAliasEntry>,
): string {
  return canonical(safeResolveType(t, aliases));
}

/**
 * Canonicalize a tag-argument-subset expression (literals, identifiers,
 * object literals) for valueArgs identity. Falls back to a loc-stripped
 * JSON walk for shapes outside the subset — stable, if verbose.
 */
function canonicalExpr(e: Expression): string {
  return JSON.stringify(e, (key, value) =>
    key === "loc" ? undefined : value,
  );
}

function canonicalValueArgs(valueArgs: Expression[] | undefined): string {
  if (!valueArgs || valueArgs.length === 0) return "";
  return `,"vargs":[${valueArgs.map(canonicalExpr).join(",")}]`;
}

function canonical(t: VariableType): string {
  switch (t.type) {
    case "typeAliasVariable":
      return `{"alias":${JSON.stringify(t.aliasName)}${canonicalValueArgs(t.valueArgs)}}`;
    case "objectType": {
      const props = t.properties
        .map((p) => `${JSON.stringify(p.key)}:${canonical(p.value)}`)
        .sort();
      return `{"object":{${props.join(",")}}}`;
    }
    case "unionType":
      return `{"union":[${t.types.map(canonical).sort().join(",")}]}`;
    case "arrayType":
      return `{"array":${canonical(t.elementType)}}`;
    case "resultType":
      return `{"result":[${canonical(t.successType)},${canonical(t.failureType)}]}`;
    case "schemaType":
      return `{"schema":${canonical(t.inner)}}`;
    case "genericType":
      return `{"generic":${JSON.stringify(t.name)},"args":[${t.typeArgs.map(canonical).join(",")}]${canonicalValueArgs(t.valueArgs)}}`;
    case "blockType":
      return `{"block":[${t.params.map((p) => canonical(p.typeAnnotation)).join(",")}],"ret":${canonical(t.returnType)}}`;
    case "functionRefType":
      return `{"fnref":${JSON.stringify(t.name)}}`;
    case "primitiveType":
      return `{"prim":${JSON.stringify(t.value)}}`;
    case "stringLiteralType":
      return `{"strlit":${JSON.stringify(t.value)}}`;
    case "numberLiteralType":
      return `{"numlit":${JSON.stringify(t.value)}}`;
    case "booleanLiteralType":
      return `{"boollit":${JSON.stringify(t.value)}}`;
    default: {
      // Exhaustiveness enforced per the typeHints.ts convention: a new
      // VariableType variant fails compilation here instead of silently
      // returning undefined.
      const exhausted: never = t;
      throw new Error(`typeKey: unhandled type variant ${JSON.stringify(exhausted)}`);
    }
  }
}
```

Cycle note: `typeKey.ts` value-imports `safeResolveType` from `assignability.ts`; Task 2 makes `assignability.ts` value-import `typeKey` back. Both uses are inside function bodies (never at module init), so the ESM cycle is safe at runtime — but if vitest/tsc complains in Task 2, move `typeKey` INTO `assignability.ts` and re-export from `typeKey.ts`.

The object-property sort renders each property string first and sorts the strings — same pattern as the union case (review finding C; no comparator ternaries). Note this canonicalizes `{a, b}` ordering correctly because each rendered string starts with the JSON-quoted key.

- [ ] **Step 4: Replace the stringify identity sites (all four)**

- `lib/typeChecker/flow.ts` `uniteTypes`: key by `typeKey(t, aliases)`; rename the `_aliases` param to `aliases` (it becomes used). Delete the KNOWN-LIMITATION comment (typeKey closes exactly those gaps) and point to `typeKey.ts` instead.
- `lib/typeChecker/flow.ts` `widenAtLoopBackEdge`: the unchanged-check must short-circuit the `"any"` sentinel BEFORE typeKey (review must-fix 3 — `ScopeType` includes `"any"`, which must never reach `canonical`):

```ts
    const unchanged =
      before === "any" || after === "any"
        ? before === after
        : typeKey(before, env.typeAliases) === typeKey(after, env.typeAliases);
    if (unchanged) {
      widened[referenceKey(r)] = before;
    } else {
      widened[referenceKey(r)] = uniteTypes(
        [before, after].filter((x): x is VariableType => x !== "any"),
        env.typeAliases,
      );
    }
```

CAREFUL: check `uniteTypes`'s current handling of `"any"` members before rewriting this call — if it already accepts `ScopeType[]` and returns `"any"` when any member is `"any"` (it does today), keep passing `[before, after]` unchanged and only replace the unchanged-check. Preserve existing behavior exactly; only the comparison changes.

- `lib/typeChecker/synthesizer.ts`: `synthLogical` (`seen.set(JSON.stringify(m), m)`), `synthArray` (`const key = JSON.stringify(t)`), `synthObject` (`uniqBy(allValueTypes, (t) => JSON.stringify(t))`), AND the block return-type dedup at ~line 1215 (review item 6 — same shape, `ctx` in scope) — all switch to `typeKey(x, ctx.getTypeAliases())`.

- [ ] **Step 5: Add the adoption pin test (review T4)**

Append to `lib/typeChecker/typeKey.test.ts`:

```ts
import { typecheckSource } from "./testUtils.js";

describe("typeKey adoption at the dedup sites", () => {
  it("a flow join of property-order-flipped object types unites to ONE member", () => {
    // Only passes when uniteTypes keys via typeKey: raw JSON.stringify
    // sees two distinct members and the union leaks into the return type,
    // making the declared annotation check fail.
    const errors = typecheckSource(`
def pick(flag: boolean): { a: number, b: number } {
  if (flag) {
    return { a: 1, b: 2 }
  }
  return { b: 2, a: 1 }
}
node main() {
  return pick(true)
}
`);
    expect(errors).toEqual([]);
  });
});
```

NOTE: verify during execution that this program actually FAILS before the flow.ts edit (run it in the red phase of Step 2 order — i.e., write it in Step 1 if convenient, or confirm red here by temporarily stashing the flow.ts change). If the checker accepts it even with raw stringify (e.g. return-position checking never goes through uniteTypes), find the join path that DOES (an `if/else`-assigned local read after the join) and pin that instead — the requirement is one behavior-level test that flips when the flow.ts wiring reverts.

- [ ] **Step 6: Suites, triage, commit**

```bash
pnpm test:run lib/typeChecker > /tmp/rec-task1-suite.log 2>&1; tail -5 /tmp/rec-task1-suite.log
pnpm test:run lib > /tmp/rec-task1-lib.log 2>&1; tail -3 /tmp/rec-task1-lib.log
pnpm run lint:structure > /tmp/rec-task1-lint.log 2>&1; tail -2 /tmp/rec-task1-lint.log
```

Unions now dedup more aggressively (aliased duplicates collapse, order stops mattering). A test asserting a union that now collapses/reorders is expected churn — update it and say so in the commit. Any other failure: stop and investigate.

```bash
git add lib/typeChecker/typeKey.ts lib/typeChecker/typeKey.test.ts lib/typeChecker/flow.ts lib/typeChecker/synthesizer.ts
git commit -m "Add canonical typeKey and adopt it at all structural-identity sites"
```

---

### Task 2: Coinductive `isAssignable` — fix the stack overflow

**Files:**
- Modify: `lib/typeChecker/assignability.ts`
- Test: `lib/typeChecker/recursiveAssignability.test.ts` (new)

**Interfaces:**
- PUBLIC `isAssignable(source, target, typeAliases)` — unchanged three-arg signature.
- PRIVATE `isAssignableGuarded(source, target, typeAliases, inProgress: Set<string>)` — all ~17 internal recursive call sites switch to this.

- [ ] **Step 1: Write the failing tests**

Create `lib/typeChecker/recursiveAssignability.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// Regression tests for issue #470 bug 2: comparing a recursive alias to
// itself used to recurse forever (each isAssignable call re-resolved the
// alias with a fresh guard) and crash with RangeError.
describe("assignability of recursive type aliases", () => {
  it("self-recursive alias vs itself terminates and accepts", () => {
    const errors = typecheckSource(`
type Tree = {
  value: number,
  children: Tree[],
}
def id(x: Tree): Tree {
  return x
}
node main() {
  const a: Tree = { value: 3, children: [{ value: 4, children: [] }] }
  const b: Tree = id(a)
  return b.value
}
`);
    expect(errors).toEqual([]);
  });

  it("mutually recursive aliases terminate and accept", () => {
    const errors = typecheckSource(`
type Forest = {
  trees: Tree[],
}
type Tree = {
  value: number,
  forest: Forest | null,
}
def id(f: Forest): Forest {
  return f
}
node main() {
  const f: Forest = { trees: [] }
  return id(f)
}
`);
    expect(errors).toEqual([]);
  });

  it("still REJECTS a genuinely incompatible recursive type", () => {
    // Anti-vacuity: a guard that returns true too eagerly fails here.
    const errors = typecheckSource(`
type Tree = {
  value: number,
  children: Tree[],
}
type NamedTree = {
  name: string,
  children: NamedTree[],
}
def wantsNamed(x: NamedTree): number {
  return 1
}
node main() {
  const t: Tree = { value: 3, children: [] }
  return wantsNamed(t)
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });

  it("removal-on-exit: a refuted pair must not be assumed true later in the SAME comparison", () => {
    // Review must-fix 4. Inside ONE top-level isAssignable call:
    // property a checks Tree ~> (NamedTree | Tree): the union tries
    // Tree~>NamedTree first (false — pair added then REMOVED), then
    // Tree~>Tree (true). Property b then re-checks Tree~>NamedTree.
    // A memoizing guard (never removes) sees the stale pair and wrongly
    // accepts; correct removal-on-exit recomputes and rejects b.
    const errors = typecheckSource(`
type Tree = {
  value: number,
  children: Tree[],
}
type NamedTree = {
  name: string,
  children: NamedTree[],
}
type Target = {
  a: NamedTree | Tree,
  b: NamedTree,
}
def wants(x: Target): number {
  return 1
}
node main() {
  const t: Tree = { value: 3, children: [] }
  return wants({ a: t, b: t })
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });
});
```

- [ ] **Step 2: Run to verify red (stack overflow)**

```bash
pnpm test:run lib/typeChecker/recursiveAssignability.test.ts > /tmp/rec-task2-red.log 2>&1; tail -5 /tmp/rec-task2-red.log
```

Expected: FAIL — the accepting tests crash with `RangeError: Maximum call stack size exceeded` (that IS the bug). The rejecting tests may crash too; all four must be green after Step 3.

- [ ] **Step 3: Implement — private guarded helper, public signature unchanged**

In `lib/typeChecker/assignability.ts` (mirroring the file's own `resolveType`/`resolveTypeWithGuard` split — review finding B):

```ts
import { typeKey } from "./typeKey.js";

export function isAssignable(
  source: VariableType | "any",
  target: VariableType | "any",
  typeAliases: Record<string, TypeAliasEntry>,
): boolean {
  return isAssignableGuarded(source, target, typeAliases, new Set());
}

function isAssignableGuarded(
  source: VariableType | "any",
  target: VariableType | "any",
  typeAliases: Record<string, TypeAliasEntry>,
  inProgress: Set<string>,
): boolean {
  if (source === "any" || target === "any") return true;

  // Coinductive cycle guard (issue #470). Cycles can only re-enter through
  // a NAMED reference (typeAliasVariable / genericType) — internal
  // recursive calls otherwise pass structurally smaller resolved nodes —
  // so the pair key is only computed when a named node is involved (perf:
  // typeKey stays off the hot path for plain structural comparisons).
  // Re-encountering an in-flight pair means we are inside the very
  // comparison that would prove or refute it — assume it holds, exactly
  // like resolveTypeWithGuard's inProgress set and TS's relation stack.
  // Entries are REMOVED on exit (try/finally): only genuine in-flight
  // cycles short-circuit; sibling repeats recompute real results.
  const named =
    source.type === "typeAliasVariable" ||
    source.type === "genericType" ||
    target.type === "typeAliasVariable" ||
    target.type === "genericType";
  if (!named) {
    return isAssignableInner(source, target, typeAliases, inProgress);
  }
  const pair = `${typeKey(source, typeAliases)}~>${typeKey(target, typeAliases)}`;
  if (inProgress.has(pair)) return true;
  inProgress.add(pair);
  try {
    return isAssignableInner(source, target, typeAliases, inProgress);
  } finally {
    inProgress.delete(pair);
  }
}
```

Rename the existing function body (from the current alias-resolution lines down) to `isAssignableInner(source, target, typeAliases, inProgress)`, and change every internal recursive call: within `assignability.ts`, each `isAssignable(<args>, typeAliases)` call inside the inner body becomes `isAssignableGuarded(<args>, typeAliases, inProgress)` (grep `isAssignable(` — ~17 sites at lines 419–698; the export and any same-file non-recursive uses of the public form stay).

The `"any"` sentinel check lives in the guarded helper (recursion re-enters there), so `typeKey` never sees the sentinel.

- [ ] **Step 4: Run to verify green, full suites, commit**

```bash
pnpm test:run lib/typeChecker/recursiveAssignability.test.ts > /tmp/rec-task2-green.log 2>&1; tail -3 /tmp/rec-task2-green.log
pnpm test:run lib > /tmp/rec-task2-lib.log 2>&1; tail -3 /tmp/rec-task2-lib.log
```

Expected: 4/4 PASS; full lib green. Compare wall-clock against Task 1's lib run — the named-node gate should keep the delta negligible; if the suite slowed noticeably anyway, profile before proceeding (do not silently accept a checker slowdown).

```bash
git add lib/typeChecker/assignability.ts lib/typeChecker/recursiveAssignability.test.ts
git commit -m "Coinductive isAssignable via private guarded helper: fixes recursive-alias stack overflow"
```

---

### Task 3: Codegen — lazy-if-not-yet-emitted zod refs (derived pending, no mutable state)

**Files:**
- Modify: `lib/backends/typescriptGenerator/typeToZodSchema.ts` (alias-ref site + `pendingAliases` threading)
- Modify: `lib/backends/typescriptBuilder.ts` (derived pending computation; `Loop = Loop` guard; tool-definition path if the probe demands it)
- Create: `tests/agency/recursive-type.agency` + `tests/agency/recursive-type.test.json`
- Create: `tests/typescriptGenerator/recursiveTypes.agency` (+ generated `.mjs`)

**Interfaces:**
- `mapTypeToValidationSchema(vt, typeAliases, typeAliasesFull?, pendingAliases?: Set<string>)` — when an alias reference names a pending alias, emit `z.lazy(() => Name)`.
- Builder-side: `pendingAliasesAt(name: string): Set<string>` — PURE function of the module's declaration list (review finding A): collect once, in source order, the names of top-level `typeAlias` nodes that have neither `typeParams` nor `valueParams` (only those emit schema consts; generic/value-param aliases inline or emit hoisted factory functions, and function-body aliases initialize at call time). Pending at the emission of alias `name` = the names at and after `name`'s index. No mutable emitted-set, no push-after-emit invariant.

- [ ] **Step 1: Create the failing execution test**

`tests/agency/recursive-type.agency`:

```
// Issue #470 bug 1: recursive/forward alias schema consts used to emit
// self/forward references in their initializers and crash at module load
// with a TDZ ReferenceError. Covers self-recursion, plain forward
// references, mutual recursion (executed, not just emitted), and a
// recursive alias used as an executed function parameter (its tool
// registration builds a module-load-time schema).
type Ahead = {
  b: Behind,
}

type Behind = {
  x: number,
}

type Tree = {
  value: number,
  children: Tree[],
}

type Employee = {
  name: string,
  manager: Manager | null,
}

type Manager = {
  reports: Employee[],
}

def depth(t: Tree): number {
  return 1
}

node forwardRef() {
  const a: Ahead = { b: { x: 1 } }
  return a
}

node accepts() {
  const s = schema(Tree)
  const r = s.parseJSON("{\"value\": 1, \"children\": [{\"value\": 2, \"children\": []}]}")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node rejects() {
  const s = schema(Tree)
  const r = s.parseJSON("{\"value\": 1, \"children\": [{\"value\": \"nope\", \"children\": []}]}")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}

node mutual() {
  const s = schema(Employee)
  const r = s.parseJSON("{\"name\": \"a\", \"manager\": {\"reports\": [{\"name\": \"b\", \"manager\": null}]}}")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node paramUse() {
  const t: Tree = { value: 1, children: [] }
  return depth(t)
}
```

`tests/agency/recursive-type.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "forwardRef",
      "input": "",
      "expectedOutput": "{\"b\":{\"x\":1}}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "forward alias reference loads and runs"
    },
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "{\"value\":1,\"children\":[{\"value\":2,\"children\":[]}]}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "recursive schema parses nested payload"
    },
    {
      "nodeName": "rejects",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "recursive schema validates at depth 2"
    },
    {
      "nodeName": "mutual",
      "input": "",
      "expectedOutput": "{\"name\":\"a\",\"manager\":{\"reports\":[{\"name\":\"b\",\"manager\":null}]}}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "mutual recursion executes end to end"
    },
    {
      "nodeName": "paramUse",
      "input": "",
      "expectedOutput": "1",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "recursive alias as executed function parameter (tool schema at module load)"
    }
  ]
}
```

- [ ] **Step 2: Run to verify red (TDZ crash)**

```bash
make > /tmp/rec-task3-make.log 2>&1; tail -2 /tmp/rec-task3-make.log
pnpm run agency test tests/agency/recursive-type.agency > /tmp/rec-task3-red.log 2>&1; echo "exit=$?"; grep -m1 'ReferenceError' /tmp/rec-task3-red.log
```

Expected: exit 1 with `ReferenceError: Cannot access ... before initialization`.

- [ ] **Step 3: Probe def-before-type (review item 7 — settle the scope question with evidence)**

```bash
cat > probe-def-first.agency <<'AGEOF'
def f(x: Later): number {
  return 1
}

type Later = {
  v: number,
}

node main() {
  return f({ v: 1 })
}
AGEOF
pnpm run agency probe-def-first.agency > /tmp/rec-task3-defprobe.log 2>&1; echo "exit=$?"; grep -m1 'ReferenceError' /tmp/rec-task3-defprobe.log; rm -f probe-def-first.agency probe-def-first.js
```

Branch on the outcome:
- **Crashes:** find the tool-definition schema emission call site (`grep -n "toolDefinition" lib/backends/typescriptBuilder.ts` — the eager `schema: z.object(...)` per `asyncAssigned.mjs:322-325`) and thread the SAME pending mechanism there: pending at a def emitted before any alias = every pending alias name at that source position (the derived list handles this: use the source position of the def relative to the alias declarations — a def before alias index i has pending = names[i..end] where i is the first alias declared after it; simplest correct form: pending = names not yet declared ABOVE the def's position). The `paramUse` execution test plus the probe re-run then verify it.
- **Does not crash** (tool schemas emit lazily already): record the observation in the plan margin, keep `paramUse` as the pin, move on.

- [ ] **Step 4: Thread `pendingAliases` through the zod mapper**

In `typeToZodSchema.ts`: add optional `pendingAliases?: Set<string>` to `mapTypeToValidationSchema` → `mapTypeToSchema` → `mapTypeToSchemaInner` (threaded exactly like `optionalKeyMode`), and change the plain alias-reference return:

```ts
    // A plain alias reference emits the alias schema const by name. When
    // the target alias is declared in the CURRENT module but its const
    // has not been emitted yet at this point (forward reference,
    // self-recursion, or a cycle back-edge), a bare name is a TDZ crash
    // at module load — defer with z.lazy, which resolves at first parse,
    // after all consts exist. Backward references keep the bare name
    // (zero churn, no indirection). Imported aliases are never pending:
    // imports initialize before the module body runs, and the pending
    // list is built from CURRENT-module declarations only.
    if (pendingAliases?.has(variableType.aliasName)) {
      return `z.lazy(() => ${variableType.aliasName})`;
    }
    return variableType.aliasName;
```

(`mapTypeToZodSchema` — the LLM-path wrapper — does NOT take the param; prompt schemas execute at run time.)

- [ ] **Step 5: Derived pending computation in the builder + the `Loop = Loop` guard**

In `typescriptBuilder.ts`:

```ts
  /**
   * Names of top-level plain aliases (no typeParams, no valueArgs params —
   * only those emit `const Name = <zod>;` statements) in declaration
   * order. Computed once per builder (builders are per-module). Function-
   * body aliases are excluded: their consts initialize at call time.
   */
  private moduleAliasEmissionOrder(): string[] {
    return this.program.nodes
      .filter(
        (n): n is TypeAlias =>
          n.type === "typeAlias" && !n.typeParams && !n.valueParams,
      )
      .map((n) => n.aliasName);
  }

  /**
   * Aliases whose const is NOT yet initialized when `name`'s const
   * initializer runs: `name` itself and everything declared after it.
   * PURE function of declaration order — no mutable emitted-set to keep
   * in sync (a stale set would silently mis-classify; see the plan
   * review, finding A).
   */
  private pendingAliasesAt(name: string): Set<string> {
    const order = this.moduleAliasEmissionOrder();
    const idx = order.indexOf(name);
    return new Set(idx === -1 ? order : order.slice(idx));
  }
```

Adjust field/receiver names to the builder's actual shape (`this.program` — check the constructor; if the builder holds nodes differently, memoize `moduleAliasEmissionOrder()` in a lazily-initialized private field). In the typeAlias emission path (the method with `const ${node.aliasName} = ${zodSchema};`), compute `const pending = this.pendingAliasesAt(node.aliasName);` and pass through `zodSchemaFor(aliasedWithTags, pending)`; `zodSchemaFor` gains the optional param and forwards it to `mapTypeToValidationSchema`. Other `zodSchemaFor` callers pass nothing.

Degenerate self-loop guard (review missing-case 7): in the same emission path, BEFORE building the schema, reject an alias whose body resolves to a bare reference to itself — `z.lazy(() => Loop)` would loop forever at first parse:

```ts
    // `type Loop = Loop` (directly or through a chain that lands back on
    // itself as a BARE reference) has no base case: its lazy schema would
    // recurse at first parse. TS rejects this shape too.
    if (
      node.aliasedType.type === "typeAliasVariable" &&
      resolveTypeDeep(node.aliasedType, this.scopes.visibleTypeAliasesFull())
        .type === "typeAliasVariable"
    ) {
      throw new Error(
        `Type alias '${node.aliasName}' circularly references itself with no structure (type ${node.aliasName} = ${(node.aliasedType as { aliasName: string }).aliasName}). Give it an object, array, or union shape.`,
      );
    }
```

Verify the throw surfaces as a compile error with the file named (the builder's existing error path). Add a typecheckSource-style or compile-CLI test pinning the message — whichever harness the builder's existing error tests use (`grep -rn "circular" lib/backends --include="*.test.ts"` for precedent; if none, a compile-level test via the CLI on a scratch file inside the test, mirroring how other builder errors are tested).

- [ ] **Step 6: Rebuild, verify green, fixture + zero-churn gate**

```bash
make > /tmp/rec-task3-make2.log 2>&1; tail -2 /tmp/rec-task3-make2.log
pnpm run agency test tests/agency/recursive-type.agency > /tmp/rec-task3-green.log 2>&1; echo "exit=$?"; tail -3 /tmp/rec-task3-green.log
```

Expected: exit 0, 5/5. (`z.infer` circularity note: generated output is transpiled, not type-checked, so inferred-type degradation is invisible at runtime — review-confirmed; if `make` itself complains about the generated fixture, observe the actual error and decide there.)

Create `tests/typescriptGenerator/recursiveTypes.agency`:

```
type Ahead = {
  b: Behind,
}

type Behind = {
  x: number,
}

type Tree = {
  value: number,
  children: Tree[],
}

type Employee = {
  name: string,
  manager: Manager | null,
}

type Manager = {
  reports: Employee[],
}

type Json = string | number | Json[]

node main() {
  const t: Tree = { value: 1, children: [] }
  return t
}
```

```bash
make fixtures > /tmp/rec-task3-fixtures.log 2>&1; tail -2 /tmp/rec-task3-fixtures.log
grep -n "z.lazy\|const Ahead\|const Tree\|const Employee\|const Manager\|const Json" tests/typescriptGenerator/recursiveTypes.mjs
git status --short tests/
```

Expected: `const Ahead` wraps its `Behind` ref in `z.lazy` (forward edge); `const Tree` wraps `Tree` (self, array-element position); `Employee` wraps `Manager` (forward edge of the mutual cycle) while `Manager` references `Employee` bare (backward edge); `const Json` wraps its self-ref inside `z.union([...])` (union position — a distinct mapper path). `git status` shows ONLY the new recursiveTypes files — any other churn means over-wrapping (likely imported aliases leaking into pending); stop and fix.

- [ ] **Step 7: Commit**

```bash
git add lib/backends/typescriptGenerator/typeToZodSchema.ts lib/backends/typescriptBuilder.ts tests/agency/recursive-type.agency tests/agency/recursive-type.test.json tests/typescriptGenerator/recursiveTypes.agency tests/typescriptGenerator/recursiveTypes.mjs
git commit -m "Emit z.lazy for not-yet-emitted alias references: fixes recursive and forward alias TDZ crashes"
```

(Include any tool-definition-path files from Step 3's crashing branch.)

---

### Task 4: Validated recursive/forward aliases — lazy descriptor refs (review must-fix 1)

Validation is a safety surface: today a validated self-recursive alias SILENTLY DROPS nested validators (the `(Tree as any).__agency_descriptor` read inside Tree's own descriptor initializer sees `undefined`), and a validated forward ref TDZ-crashes. Chosen fix: a deferred descriptor node — small, runtime-walker-native, and the walker's existing `maxDepth` already bounds recursive walks. Fallback if execution reveals this ballooning: replace with a clear compile error ("validated recursive aliases are not yet supported") plus a pinning test and a follow-up issue — do NOT ship the silent loss.

**Files:**
- Modify: `lib/runtime/validateChain.ts` (new descriptor kind + walker case)
- Modify: `lib/backends/typescriptGenerator/validationDescriptor.ts` (lazy alias-ref emission; thread `pendingAliases` into `schemaNode`)
- Modify: `lib/backends/typescriptBuilder.ts` (pass pending into `buildValidationDescriptor`)
- Test: `lib/runtime/validateChain.test.ts` (walker case), `tests/agency/recursive-type-validated.agency` + `.test.json`

- [ ] **Step 1: Write the failing execution test**

`tests/agency/recursive-type-validated.agency`:

```
// Validated recursive alias: nested validators must run at every level.
// Before the lazy-descriptor fix, the self-referencing descriptor read
// its own __agency_descriptor mid-assignment (undefined) and nested
// validation silently vanished — accepts() would pass a payload that
// rejects() proves should fail one level down.
def positive(n: number): Result<number, string> {
  if (n > 0) {
    return success(n)
  }
  return failure("must be positive")
}

type Tree = {
  @validate(positive)
  value: number,
  children: Tree[],
}

node accepts() {
  const s = schema(Tree)
  const r = s.parseJSON("{\"value\": 1, \"children\": [{\"value\": 2, \"children\": []}]}")
  if (isSuccess(r)) {
    return "ok"
  }
  return "parse failed"
}

node rejectsNested() {
  const s = schema(Tree)
  const r = s.parseJSON("{\"value\": 1, \"children\": [{\"value\": -5, \"children\": []}]}")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

`tests/agency/recursive-type-validated.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "\"ok\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "valid nested payload passes recursive validation"
    },
    {
      "nodeName": "rejectsNested",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "validator fires at nesting depth 2 (silent-loss regression pin)"
    }
  ]
}
```

NOTE: verify the `@validate` + `schema(...).parseJSON` combination runs validators (the validation path is `mapTypeToValidationSchema` + descriptor walk — see `docs/dev/validation-annotations.md`); if validators only fire through the `!` annotation form, rewrite the two nodes to use `const t: Tree! = ...`-style validated assignment with the same accept/reject structure. The load-bearing assertion is `rejectsNested`.

- [ ] **Step 2: Run to verify red**

```bash
make > /tmp/rec-task4-make.log 2>&1; tail -2 /tmp/rec-task4-make.log
pnpm run agency test tests/agency/recursive-type-validated.agency > /tmp/rec-task4-red.log 2>&1; echo "exit=$?"; tail -4 /tmp/rec-task4-red.log
```

Expected after Task 3: loads fine (z.lazy fixed the const), `accepts` passes, `rejectsNested` FAILS with `"accepted"` — the silent validator loss, observed. (If it crashes instead, that is the forward-ref TDZ variant; same fix.)

- [ ] **Step 3: Add the `ref` descriptor kind and walker case**

In `lib/runtime/validateChain.ts`, extend the union:

```ts
  | {
      kind: "ref";
      /**
       * Deferred descriptor read. Emitted for alias references whose
       * target descriptor is not initialized yet at module load (forward
       * refs) or is the descriptor currently being built (self-recursion).
       * Resolved at walk time, when every __agency_descriptor exists.
       */
      get: () => TypeValidationDescriptor;
    }
```

and add the walker case (in the `walk` function's dispatch; depth passes through unchanged — the structural kinds below the ref already increment it, and `maxDepth` bounds runaway):

```ts
    case "ref":
      return walk(value, descriptor.get(), depth, maxDepth);
```

Unit-test in `lib/runtime/validateChain.test.ts` following the file's existing test style: a self-referential object descriptor via `ref` validates a two-level value and rejects a bad nested leaf; a `maxDepth`-exceeded deep value hits the existing cap behavior (pin whatever the cap does today — error or accept — do not change it).

- [ ] **Step 4: Emit lazy descriptor refs + thread pending into `schemaNode`**

In `validationDescriptor.ts`:

1. The nested alias-ref site (~line 296) becomes ALWAYS deferred (unconditional — laziness is always safe here, and conditioning on pending would leave the self-ref silent-loss case since the self name IS pending anyway):

```ts
    if (entry && hasAliasValidate(entry, typeAliasesFull)) {
      // Deferred: reading `(Alias as any).__agency_descriptor` eagerly is
      // a TDZ crash for forward refs and — worse — silently `undefined`
      // for self-refs (the assignment is in progress), which drops nested
      // validation. `{ kind: "ref", get }` defers the read to walk time.
      const aliasRef = ts.raw(
        `{ kind: "ref", get: () => (${variableType.aliasName} as any).__agency_descriptor }`,
      );
      return withUseSiteValidators(aliasRef, useSiteValidators);
    }
```

CHECK `withUseSiteValidators` first: if it wraps by spreading fields onto the node, wrapping a `ref` needs the wrap to happen INSIDE `get()` or via a `nullable`-style wrapper node — read its implementation and put the use-site validators on whichever layer keeps them running (add a walker unit test for ref-with-use-site-validators either way).

2. Thread `pendingAliases` into `schemaNode` (~line 173) and its `mapTypeToValidationSchema` call, plumbed from `buildValidationDescriptor`'s signature; in `typescriptBuilder.ts`, the descriptor build site (~line 793-799) passes the same `pending` set Task 3 computed.

- [ ] **Step 5: Verify green, fixture churn review, commit**

```bash
make > /tmp/rec-task4-make2.log 2>&1; tail -2 /tmp/rec-task4-make2.log
pnpm test:run lib/runtime/validateChain.test.ts > /tmp/rec-task4-walker.log 2>&1; tail -3 /tmp/rec-task4-walker.log
pnpm run agency test tests/agency/recursive-type-validated.agency > /tmp/rec-task4-green.log 2>&1; echo "exit=$?"; tail -3 /tmp/rec-task4-green.log
make fixtures > /tmp/rec-task4-fixtures.log 2>&1; git status --short tests/ | tee /tmp/rec-task4-churn.log
```

Descriptor-path fixture churn is EXPECTED here (alias-ref descriptors change shape everywhere they exist) — review each churned fixture diff: every change must be exactly `(X as any).__agency_descriptor` → `{ kind: "ref", get: () => (X as any).__agency_descriptor }` (or schemaNode lazy wraps). Anything else: stop.

```bash
git add lib/runtime/validateChain.ts lib/runtime/validateChain.test.ts lib/backends/typescriptGenerator/validationDescriptor.ts lib/backends/typescriptBuilder.ts tests/agency/recursive-type-validated.agency tests/agency/recursive-type-validated.test.json tests/typescriptGenerator
git commit -m "Defer validation-descriptor alias reads: fixes TDZ and silent validator loss on recursive aliases"
```

---

### Task 5: Structured-output path — pin the `$ref` conversion (review T6)

**Files:**
- Modify: `tests/typescriptGenerator/recursiveTypes.agency` (llm node)
- Create: `lib/backends/typescriptGenerator/recursiveSchemaJson.test.ts`

- [ ] **Step 1: LLM-path fixture node**

Append to `tests/typescriptGenerator/recursiveTypes.agency` and regenerate:

```
node llmTree() {
  const suggested: Tree = llm("Suggest a small tree")
  return suggested
}
```

```bash
make fixtures > /tmp/rec-task5-fixtures.log 2>&1; grep -n "responseFormat" -A3 tests/typescriptGenerator/recursiveTypes.mjs | head -8
```

Expected: `responseFormat` references the `Tree` const by name (runtime reference — no lazy needed, executes post-load).

- [ ] **Step 2: Find the runtime JSON-schema conversion and COMMIT a pin test**

```bash
grep -rn "toJSONSchema\|zodToJson" lib/ --include="*.ts" | grep -v test | head -5
grep -rn "toJSONSchema" node_modules/smoltalk/dist/*.js 2>/dev/null | head -3
```

zod is `^4.3.5`, so the conversion is `z.toJSONSchema` (zod 4 handles cycles via `$ref`). Create `lib/backends/typescriptGenerator/recursiveSchemaJson.test.ts` pinning the conversion ON THE SHAPE THIS PLAN EMITS (a caret-range zod upgrade changing cycle handling must go red here, not in production):

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";

// Pins that the exact schema shape our codegen emits for recursive
// aliases (z.lazy self-reference, per tests/typescriptGenerator/
// recursiveTypes.mjs) survives the JSON-schema conversion the LLM
// structured-output path uses, producing a $ref instead of throwing or
// inlining forever. zod is caret-pinned; an upgrade that changes cycle
// handling must fail THIS test, not a user request.
describe("recursive zod schema to JSON schema", () => {
  it("z.lazy self-reference converts with a $ref and does not throw", () => {
    const Tree: z.ZodType = z.object({
      value: z.number(),
      children: z.array(z.lazy(() => Tree)),
    });
    const json = JSON.stringify(z.toJSONSchema(Tree));
    expect(json).toContain("$ref");
  });
});
```

Adjust the conversion call to whatever the first grep shows the runtime ACTUALLY uses (same API, same options — if smoltalk calls it with options, mirror them; if the conversion lives in smoltalk internals, import and call the same smoltalk entry point the prompt path uses). If the conversion THROWS on cycles (unexpected for zod 4): switch to the plan rev-1 fallback — a guarded, actionable error at the prompt-construction site (`Recursive type cannot be used as a structured-output type with this provider — parse with schema(...).parseJSON instead`) plus an execution test pinning the message with no LLM call.

- [ ] **Step 3: Commit**

```bash
git add tests/typescriptGenerator lib/backends/typescriptGenerator/recursiveSchemaJson.test.ts
git commit -m "Pin recursive-type structured-output JSON schema conversion"
```

---

### Task 6: Utility-type composition + docs

**Files:**
- Test: extend `lib/typeChecker/builtinGenerics.test.ts`; extend `tests/typescriptGenerator/recursiveTypes.agency`; create `tests/agency/recursive-type-partial.agency` + `.test.json`
- Modify: `docs/site/guide/types.md`, `docs/dev/typechecker/README.md`

- [ ] **Step 1: Typecheck pin — `Partial<Tree>`**

Append to the pipeline describe in `lib/typeChecker/builtinGenerics.test.ts`:

```ts
  it("Partial of a recursive alias works shallowly (#470 unblocked)", () => {
    const errors = typecheckSource(`
type Tree = {
  value: number,
  children: Tree[],
}
node main() {
  const t: Partial<Tree> = { value: null, children: null }
  return t
}
`);
    expect(errors).toEqual([]);
  });
```

- [ ] **Step 2: Codegen + execution — `Partial<Tree>` through the pending logic**

Add to `tests/typescriptGenerator/recursiveTypes.agency` (before `node main`), regenerate, and grep:

```
type TreePatch = Partial<Tree>
```

Expected in the `.mjs`: `const TreePatch = z.object(...)` whose expanded initializer wraps its `Tree` reference in `z.lazy` — this exercises pending through the builtin-generic expansion path (the Partial transform inlines Tree's body whose `children` element is a nominal `Tree` ref, still pending at TreePatch's position ONLY if TreePatch precedes... it does NOT: TreePatch is declared after Tree, so the ref is BACKWARD and stays bare. Move the `TreePatch` declaration ABOVE `type Tree` in the fixture so the expanded ref is genuinely forward and must wrap.) Verify the grep shows `z.lazy(() => Tree)` inside `const TreePatch`.

Create `tests/agency/recursive-type-partial.agency` + `.test.json` mirroring `utility-partial.agency`: `schema(Partial<Tree>).parseJSON("{}")` (bind schema to a variable first — chaining on `schema(...)` does not parse, #480) accepts with keys null-coalesced, and a reject case with a wrongly-typed present key. Expected outputs follow the utility-partial serialization exactly.

- [ ] **Step 3: Docs**

`docs/site/guide/types.md` — short section (the owner trims verbosity; keep it to this):

```markdown
## Recursive types

Type aliases can reference themselves, each other, or aliases declared
later in the file:

```ts
type Tree = {
  value: number,
  children: Tree[],
}
```

`schema(Tree)` validates nested payloads at every level, including
`@validate` annotations on nested fields.
```

`docs/dev/typechecker/README.md` — in the `isAssignable` section: one paragraph on coinduction (in-progress pair stack keyed by `typeKey`, entries removed on exit, gated on named references; what makes recursive aliases comparable). In the narrowing/`never` cross-references, remove any "recursion unsupported" claims if present.

- [ ] **Step 4: Run the new tests, commit**

```bash
pnpm test:run lib/typeChecker/builtinGenerics.test.ts > /tmp/rec-task6-bg.log 2>&1; tail -3 /tmp/rec-task6-bg.log
pnpm run agency test tests/agency/recursive-type-partial.agency > /tmp/rec-task6-partial.log 2>&1; echo "exit=$?"
git add lib/typeChecker/builtinGenerics.test.ts tests/typescriptGenerator tests/agency/recursive-type-partial.agency tests/agency/recursive-type-partial.test.json docs/site/guide/types.md docs/dev/typechecker/README.md
git commit -m "Pin utility-type and recursion composition; document recursive types"
```

---

### Task 7: Full verification, push, PR

- [ ] **Step 1: Full sweep**

```bash
pnpm test:run lib > /tmp/rec-task7-lib.log 2>&1; tail -3 /tmp/rec-task7-lib.log
pnpm run lint:structure > /tmp/rec-task7-lint.log 2>&1; echo "lint=$?"
make > /tmp/rec-task7-make.log 2>&1; echo "make=$?"
for t in recursive-type recursive-type-validated recursive-type-partial utility-partial; do pnpm run agency test tests/agency/$t.agency > /tmp/rec-task7-$t.log 2>&1; echo "$t: $?"; done
```

All green (utility-partial re-run guards the merged feature against typeKey/coinduction regressions).

- [ ] **Step 2: PR**

Body file must cover: closes #470, closes #473; the forward-reference and silent-validator-loss discoveries; the four mechanisms and why each (derived pending over mutable state, private guarded helper over signature leak, lazy descriptor refs over a compile error, named-node gate soundness); the def-before-type probe outcome; and the scope-outs (inference.ts `unionTypes` stringify residual noted on #473; recursive value-param alias codegen hang → file the follow-up issue and link it; zod-mapper parameter sprawl watch). Then:

```bash
git push -u origin recursive-types
gh pr create --title "Fix recursive and forward-referencing type aliases (closes #470, closes #473)" --body-file /tmp/rec-pr-body.md
```
