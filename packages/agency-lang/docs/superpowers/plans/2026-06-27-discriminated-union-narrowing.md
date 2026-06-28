# Discriminated-Union Narrowing (D1 + D2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Post-review revision.** Folds in three reviews (`.review.md`, `.anti-patterns.md`, `.tests.md`): (A) reuse existing literal *types* instead of a parallel `LiteralValue`; (B) declarative `narrowers` dispatch table; corrected match-arm witnessing test; added coverage (boolean/numeric/3+member/scope-leak/while/post-guard/&&/!/non-union); **the binding hint is deferred** (the gated version needs an `ObjectType` narrowing marker that conflicts with `result-as-union` removing `narrowedBranch` — not worth it now; the unconditional version misfires on plain-object typos).

> **Second-review correction (verified against `main`).** `synthType` does **not** currently convert numeric/boolean literals to literal types — only the *string* case yields a `stringLiteralType`; `number`/`unitLiteral` → `NUMBER_T` and `boolean` → `BOOLEAN_T` (`synthesizer.ts:142-164`). So the DRY refactor of `synthType` is scoped to the **string case only** (Task 2 Step 1); routing `number`/`boolean` through `literalToType` would change inference (`let x = 42` → literal `42` instead of `number`) and break the "type-checker-only / no behavior change" guarantee. `literalToType` itself still produces all three literal types — the recognizer needs them, and the numeric/boolean narrowing tests rely on the **type parser** (not `synthType`) producing literal types in `{ code: 1 }` / `{ ok: true }` annotations, which it does.

**Goal:** Narrow a union-typed variable when a branch tests its discriminant — `if (r.kind == "answer") { … }` narrows `r` to the matching member(s). Foundation for the rest of the narrowing program.

**Architecture:** Extend the merged Increment 1–2 engine (`lib/typeChecker/narrowing.ts`). Generalize `NarrowCandidate` to a tagged `{ refine }` (`resultBranch | discriminant`); dispatch via a declarative `narrowers` table; teach `analyzeCondition` to recognize `v.prop == literal` / `!= literal`; add `narrowUnionByDiscriminant`. Type-checker-only — no AST/codegen change, so interrupts are unaffected.

**Tech Stack:** TypeScript, vitest. Spec: `discriminated-union-narrowing-spec.md` (repo root).

## Global Constraints

- NEVER use dynamic imports. Use `type` aliases not `interface`. No one-line `if`s (anti-patterns.md). (CLAUDE.md)
- vitest **unit** tests: `npx vitest run <path>`, NOT the agency runner.
- **Type-checker-only.** No lowering/codegen change. Merged Result narrowing must stay behavior-identical (its e2e tests in `narrowing.test.ts` are the Task 1 gate).
- **Sound: false-negative only.** Never exclude a member that could match; never narrow to `never`; non-union/unknown → no narrowing. Variable-keyed scrutinee only.
- **DRY:** reuse existing literal-type construction and `safeResolveType`; do not build a parallel literal system.
- **Verified facts (live on `main`):**
  - `narrowing.ts`: `NarrowCandidate = { variableName; branch }`, `ConditionFacts = { then; else }`, `analyzeCondition(condition: Expression): ConditionFacts`, `applyNarrowing(childScope, candidates, branchBody, typeAliases)`, `narrowToBranch(rt, branch)`, `isReassignedIn(body, name)`; `safeResolveType` imported from `./assignability.js`. `NarrowCandidate` is consumed **only** inside `narrowing.ts` (scopes.ts uses the helpers, never `.branch`) — so `tsc` is a reliable gate for the Task 1 rename.
  - `ValueAccess = { type:"valueAccess"; base; chain }`; `v.kind` = base `{type:"variableName", value:"v"}` + one `{kind:"property", name:"kind"}`.
  - Literal AST → literal type: in `synthType` (`synthesizer.ts:142-164`) **only the string case** yields a literal type today — string with `segments.length===1 && segments[0].type==="text"` → `{type:"stringLiteralType", value}` (else `STRING_T`). `number`/`unitLiteral` → `NUMBER_T`; `boolean` → `BOOLEAN_T` (general types, **not** literal types). `literalToType` (this plan) intentionally produces all three (`number` → `{type:"numberLiteralType", value: e.value}` where the AST `number` node's `value` is a **string**; `boolean` → `{type:"booleanLiteralType", value: e.value?"true":"false"}`) for the recognizer — but `synthType` is only refactored on its string case (see Task 2 Step 1).
  - Discriminant literal types in union members come from the **type-annotation parser**, not `synthType`: `{ kind: "answer" }` → `stringLiteralType`, `{ code: 1 }` → `numberLiteralType` (`value:"1"`), `{ ok: true }` → `booleanLiteralType` (`value:"true"`). Verified via `pnpm run ast`. This is what the numeric/boolean e2e narrowing tests depend on.
  - Literal types: `stringLiteralType`/`numberLiteralType` (`value: string`), `booleanLiteralType` (`value:"true"|"false"`). `ObjectType.properties: {key, value}[]`.
  - `synthValueAccess`: lenient `unionType` branch (`synthesizer.ts:648-672`) returns the prop's type from members that have it (errors only if none do); strict `objectType` branch (`:673-683`) errors "Property … does not exist". The witnessing tests exploit this: narrowing to a single member makes an other-member field error.

---

## File Structure

- **Create** `lib/typeChecker/literalType.ts` — `literalToType(expr)` shared by the recognizer and (refactored) `synthesizer.ts`.
- **Modify** `lib/typeChecker/narrowing.ts` — `Refine`/`NarrowCandidate`; `narrowers` table dispatch; discriminant recognizer; `narrowUnionByDiscriminant`.
- **Modify** `lib/typeChecker/synthesizer.ts` — reuse `literalToType` for the **string** case at `:145-150` only (DRY); leave `number`/`boolean` returning `NUMBER_T`/`BOOLEAN_T` (behavior-preserving).
- **Modify** `lib/typeChecker/narrowing.test.ts` — update existing `analyzeCondition` unit tests; add discriminant unit + e2e + match-arm tests.

---

### Task 1: Tagged `Refine` + declarative `narrowers` dispatch (behavior-preserving)

Pure refactor: Result narrowing works identically; only representation + dispatch change so the discriminant variant slots in (Task 2) and future variants (presence; removing resultBranch) are one table edit.

**Files:** Modify `lib/typeChecker/narrowing.ts`; Test `lib/typeChecker/narrowing.test.ts`.

**Interfaces:**
- Produces: `Refine = { kind:"resultBranch"; branch:"success"|"failure" } | { kind:"discriminant"; prop:string; literal: StringLiteralType|NumberLiteralType|BooleanLiteralType; keep:boolean }`; `NarrowCandidate = { variableName:string; refine: Refine }`; a `narrowers` table `{ [K in Refine["kind"]]: (refine, current, aliases) => VariableType | null }`.

- [ ] **Step 1: Update existing `analyzeCondition` unit tests to the `refine` shape**

In `narrowing.test.ts`, wrap every `{ variableName, branch }` expectation as `{ variableName, refine: { kind: "resultBranch", branch } }` — the `isSuccess`/`isFailure`/`!`/`&&`/`||`/double-negation cases. `produces no candidates` cases stay `{ then: [], else: [] }`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "analyzeCondition"` — Expected: FAIL (code still emits `{ variableName, branch }`).

- [ ] **Step 3: Add the types + table; update `analyzeCondition` + `applyNarrowing`**

In `narrowing.ts` add the imports `import type { VariableType } from "../types.js";` and `import type { StringLiteralType, NumberLiteralType, BooleanLiteralType } from "../types/typeHints.js";`, then:

```ts
export type Refine =
  | { kind: "resultBranch"; branch: "success" | "failure" }
  | {
      kind: "discriminant";
      prop: string;
      literal: StringLiteralType | NumberLiteralType | BooleanLiteralType;
      keep: boolean;
    };
export type NarrowCandidate = { variableName: string; refine: Refine };

// "what": given a refine + the variable's current type, the narrowed type (or null).
// "how" (loop, reassignment gate, declareLocal) lives in applyNarrowing.
const narrowers: {
  [K in Refine["kind"]]: (
    refine: Extract<Refine, { kind: K }>,
    current: VariableType,
    aliases: Record<string, TypeAliasEntry>,
  ) => VariableType | null;
} = {
  resultBranch: (r, current, aliases) => {
    const resolved = safeResolveType(current, aliases);
    return resolved.type === "resultType" ? narrowToBranch(resolved, r.branch) : null;
  },
  // discriminant added in Task 2
  discriminant: () => null,
};
```

Update the `isSuccess`/`isFailure` return in `analyzeCondition`:

```ts
  return {
    then: [{ variableName: name, refine: { kind: "resultBranch", branch: thenBranch } }],
    else: [{ variableName: name, refine: { kind: "resultBranch", branch: elseBranch } }],
  };
```

Replace the body of `applyNarrowing`'s loop with the declarative dispatch:

```ts
  for (const cand of candidates) {
    const current = childScope.lookup(cand.variableName);
    if (!current || current === "any") continue;
    if (isReassignedIn(branchBody, cand.variableName)) continue;
    const narrow = narrowers[cand.refine.kind];
    const narrowed = narrow(cand.refine as never, current, typeAliases);
    if (narrowed !== null) childScope.declareLocal(cand.variableName, narrowed);
  }
```

- [ ] **Step 4: Run the full narrowing suite (Result equivalence gate)**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts 2>&1 | tee /tmp/d1t1.log` — Expected: PASS; **all existing Result e2e tests pass unchanged**. A failure means the dispatch diverged from the old Result path.

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit` — Expected: clean.

```bash
git add lib/typeChecker/narrowing.ts lib/typeChecker/narrowing.test.ts
git commit -F - <<'EOF'
refactor(typechecker): tagged Refine + declarative narrowers dispatch

NarrowCandidate becomes { refine } (resultBranch | discriminant), dispatched
via a narrowers table keyed by refine.kind. Splits the "what to narrow to"
from the "how" (loop, reassignment gate, declareLocal). Behavior-preserving;
the discriminant entry is wired next.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Discriminant narrowing engine (Form 1)

**Files:** Create `lib/typeChecker/literalType.ts`; Modify `lib/typeChecker/narrowing.ts`, `lib/typeChecker/synthesizer.ts`; Test `lib/typeChecker/narrowing.test.ts`.

**Interfaces:**
- Produces: `literalToType(e: Expression): StringLiteralType | NumberLiteralType | BooleanLiteralType | null`; `analyzeCondition` recognizes `v.prop ==/!= literal`; `narrowUnionByDiscriminant(type, prop, literal, keep, aliases): VariableType | null`.

- [ ] **Step 1: Verify the literal AST shape, then extract `literalToType` (DRY)**

First confirm the canonical literal shape (Concern: template literals): `pnpm run ast` on a file containing `if (r.kind == "answer") {}` — confirm `"answer"` is `{type:"string", segments:[{type:"text", value:"answer"}]}`. (A bare `` `answer` `` template with no holes may differ; if so, document non-coverage — do not special-case it in D1.)

Create `lib/typeChecker/literalType.ts`:

```ts
import type { Expression } from "../types.js";
import type {
  StringLiteralType,
  NumberLiteralType,
  BooleanLiteralType,
} from "../types/typeHints.js";

/** Convert a literal expression to its literal type, or null if not a simple
 *  literal. Single source of truth — `synthType`'s literal cases also use it. */
export function literalToType(
  e: Expression,
): StringLiteralType | NumberLiteralType | BooleanLiteralType | null {
  if (e.type === "string" && e.segments.length === 1 && e.segments[0].type === "text") {
    return { type: "stringLiteralType", value: e.segments[0].value };
  }
  if (e.type === "number") {
    return { type: "numberLiteralType", value: e.value };
  }
  if (e.type === "boolean") {
    return { type: "booleanLiteralType", value: e.value ? "true" : "false" };
  }
  return null;
}
```

Refactor **only the `string` case** of `synthType` (`synthesizer.ts:145-150`) to delegate to `literalToType` — that is the lone case that already produces a literal type, so this is behavior-preserving:

```ts
    case "string":
      return literalToType(expr) ?? STRING_T;
```

**Do NOT touch the `number`/`unitLiteral` or `boolean` cases** — they must keep returning `NUMBER_T`/`BOOLEAN_T`. Routing them through `literalToType` would make `synthType` infer literal types (`let x = 42` → `42` instead of `number`), a real behavior change that violates the type-checker-only guarantee and regresses inference/assignability tests. `literalToType` still returns all three literal types; only the recognizer (Step 4) consumes the numeric/boolean ones. Run `npx vitest run lib/typeChecker/ 2>&1 | tee /tmp/d1-synth.log` to confirm no regression (string-literal inference unchanged; number/boolean untouched).

- [ ] **Step 2: Write the failing recognizer unit tests**

Append to the `analyzeCondition` describe:

```ts
const disc = (keep: boolean, value = "answer", prop = "kind") => ({
  variableName: "r",
  refine: { kind: "discriminant", prop, literal: { type: "stringLiteralType", value }, keep },
});

it.each([
  ['r.kind == "answer"', true, false],
  ['"answer" == r.kind', true, false],   // operand swap
  ['r.kind != "answer"', false, true],
  ['"answer" != r.kind', false, true],   // operand swap, !=
])("recognizes %s", (src, thenKeep, elseKeep) => {
  const f = analyzeCondition(firstIfCondition(src));
  expect(f.then[0]).toEqual(disc(thenKeep));
  expect(f.else[0]).toEqual(disc(elseKeep));
});

it("recognizes numeric and boolean discriminants", () => {
  expect(analyzeCondition(firstIfCondition("n.code == 1")).then[0].refine).toEqual(
    { kind: "discriminant", prop: "code", literal: { type: "numberLiteralType", value: "1" }, keep: true },
  );
  expect(analyzeCondition(firstIfCondition("r.ok == true")).then[0].refine).toEqual(
    { kind: "discriminant", prop: "ok", literal: { type: "booleanLiteralType", value: "true" }, keep: true },
  );
});

it.each([
  "r.kind == s.kind",      // both member access
  "x == 1",                // no member access
  'r.a.kind == "x"',       // nested member — out of scope
  "r.kind == r.text",      // same var both sides, no literal
  'r.kind == undefined',   // undefined is a variableName, not a literal
])("produces no candidates for %s", (src) => {
  expect(analyzeCondition(firstIfCondition(src))).toEqual({ then: [], else: [] });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "analyzeCondition"` — Expected: the new cases FAIL (no `==`/`!=` handling).

- [ ] **Step 4: Add the recognizer to `analyzeCondition`**

In `narrowing.ts`, import `literalToType` and add `asDiscriminantAccess`:

```ts
function asDiscriminantAccess(e: Expression): { variableName: string; prop: string } | null {
  if (e.type !== "valueAccess") return null;
  if (e.base.type !== "variableName") return null;
  if (e.chain.length !== 1) return null;
  const el = e.chain[0];
  if (el.kind !== "property") return null;
  return { variableName: e.base.value, prop: el.name };
}
```

Inside the `binOpExpression` block, before its final `return NO_FACTS`:

```ts
    if (condition.operator === "==" || condition.operator === "!=") {
      const acc = asDiscriminantAccess(condition.left) ?? asDiscriminantAccess(condition.right);
      const lit = literalToType(condition.right) ?? literalToType(condition.left);
      if (!acc || !lit) return NO_FACTS;
      const keepThen = condition.operator === "==";
      const mk = (keep: boolean): NarrowCandidate => ({
        variableName: acc.variableName,
        refine: { kind: "discriminant", prop: acc.prop, literal: lit, keep },
      });
      return { then: [mk(keepThen)], else: [mk(!keepThen)] };
    }
```

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "analyzeCondition"` — Expected: PASS.

- [ ] **Step 5: Write the failing e2e tests**

Append a new describe. Fixtures use the witnessing strategy; assertions use `.filter(...).length` for precision.

```ts
const REPLY = `
type Reply = { kind: "answer", text: string } | { kind: "clarify", question: string }
def mk(): Reply { return { kind: "answer", text: "x" } }
`;
const has = (errs: string[], re: RegExp) => errs.filter((e) => re.test(e)).length;
const noQuestion = /question.*does not exist|does not exist.*question/;
const noText = /\btext\b.*does not exist|does not exist.*\btext\b/;

describe("discriminated-union narrowing — if/else", () => {
  it("narrows to the matching member in then; complement in else", () => {
    const errs = check(`${REPLY}
node main() {
  let r = mk()
  if (r.kind == "answer") { let q = r.question } else { let t = r.text }
}`);
    expect(has(errs, noQuestion)).toBe(1); // then: r is answer → no `question`
    expect(has(errs, noText)).toBe(1);     // else: r is clarify → no `text`
  });

  it("does NOT narrow outside the guard (control)", () => {
    const errs = check(`${REPLY}
node main() { let r = mk()\n  let q = r.question }`);
    expect(has(errs, noQuestion)).toBe(0); // lenient union access
  });

  it("does NOT leak narrowing past the block", () => {
    const errs = check(`${REPLY}
node main() {
  let r = mk()
  if (r.kind == "answer") { }
  let q = r.question
}`);
    expect(has(errs, noQuestion)).toBe(0);
  });

  it("skips narrowing when the variable is reassigned in the branch", () => {
    const errs = check(`${REPLY}
node main() {
  let r = mk()
  if (r.kind == "answer") { r = mk()\n    let q = r.question }
}`);
    expect(has(errs, noQuestion)).toBe(0);
  });

  it("narrows via != (then is complement)", () => {
    const errs = check(`${REPLY}
node main() {
  let r = mk()
  if (r.kind != "answer") { let t = r.text }
}`);
    expect(has(errs, noText)).toBe(1); // then: r is clarify → no `text`
  });

  it("narrows in a while body", () => {
    const errs = check(`${REPLY}
node main() {
  let r = mk()
  while (r.kind == "answer") { let q = r.question }
}`);
    expect(has(errs, noQuestion)).toBe(1);
  });

  it("narrows after an early-return guard (postGuardFacts × discriminant)", () => {
    const errs = check(`${REPLY}
node main() {
  let r = mk()
  if (r.kind != "answer") { return }
  let q = r.question
}`);
    expect(has(errs, noQuestion)).toBe(1); // r is answer below the guard
  });

  it("composes with && and !", () => {
    const andErrs = check(`${REPLY}
node main() {
  let r = mk()
  if (r.kind == "answer" && true) { let q = r.question }
}`);
    expect(has(andErrs, noQuestion)).toBe(1);
    const notErrs = check(`${REPLY}
node main() {
  let r = mk()
  if (!(r.kind == "answer")) { let t = r.text }
}`);
    expect(has(notErrs, noText)).toBe(1); // !(==answer) then → complement (clarify) → no text
  });
});

describe("discriminated-union narrowing — literal kinds & shapes", () => {
  it("narrows a boolean discriminant (foundation for r.success)", () => {
    const errs = check(`
type Tag = { ok: true, v: number } | { ok: false, err: string }
def mkT(): Tag { return { ok: true, v: 1 } }
node main() {
  let t = mkT()
  if (t.ok == true) { let e = t.err }
}`);
    expect(has(errs, /\berr\b.*does not exist|does not exist.*\berr\b/)).toBe(1);
  });

  it("narrows a numeric discriminant", () => {
    const errs = check(`
type N = { code: 1, a: number } | { code: 2, b: string }
def mkN(): N { return { code: 1, a: 1 } }
node main() {
  let n = mkN()
  if (n.code == 1) { let b = n.b }
}`);
    expect(has(errs, /\bb\b.*does not exist|does not exist.*\bb\b/)).toBe(1);
  });

  it("narrows a 3-member union to a 2-member union", () => {
    const errs = check(`
type T = { k: "a", x: number } | { k: "b", y: string } | { k: "c", z: boolean }
def mkT3(): T { return { k: "a", x: 1 } }
node main() {
  let t = mkT3()
  if (t.k != "a") { let x = t.x }
}`);
    // then: t is {b}|{c}; neither has `x` → error.
    expect(has(errs, /\bx\b.*does not exist|does not exist.*\bx\b/)).toBe(1);
  });

  it("is a no-op on a non-union scrutinee", () => {
    const errs = check(`
node main() {
  let p: { kind: string, n: number } = { kind: "x", n: 1 }
  if (p.kind == "x") { let n = p.n }
}`);
    expect(errs.filter((e) => /does not exist/.test(e)).length).toBe(0);
  });

  it("does NOT narrow a mixed union with a non-literal discriminant member", () => {
    const errs = check(`
type Mixed = { kind: "a", x: number } | { kind: string, y: number }
def mkM(): Mixed { return { kind: "a", x: 1 } }
node main() {
  let m = mkM()
  if (m.kind == "a") { let y = m.y }
}`);
    // {kind:string} can't be proven disjoint → kept → no narrowing → m.y fine.
    expect(errs.filter((e) => /does not exist/.test(e)).length).toBe(0);
  });
});
```

- [ ] **Step 6: Run to verify the positive cases fail**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "discriminated-union narrowing"` — Expected: the narrowing-positive tests FAIL (no member filtering yet); control/leak/reassignment/non-union/mixed pass.

- [ ] **Step 7: Add `narrowUnionByDiscriminant` + the `narrowers` discriminant entry**

In `narrowing.ts`:

```ts
function literalTypeMatches(
  t: VariableType,
  literal: StringLiteralType | NumberLiteralType | BooleanLiteralType,
  aliases: Record<string, TypeAliasEntry>,
): "yes" | "no" | "unknown" {
  const r = safeResolveType(t, aliases);
  if (r.type !== literal.type) return "unknown"; // non-literal prop, literal union, or kind mismatch
  return r.value === literal.value ? "yes" : "no";
}

/**
 * Filter a union's members by `prop == literal` (keep) or `prop != literal`
 * (!keep). Sound/conservative: drops only provably-excluded members; never
 * narrows to `never`; non-union → null (no narrowing).
 */
export function narrowUnionByDiscriminant(
  type: VariableType,
  prop: string,
  literal: StringLiteralType | NumberLiteralType | BooleanLiteralType,
  keep: boolean,
  aliases: Record<string, TypeAliasEntry>,
): VariableType | null {
  const resolved = safeResolveType(type, aliases);
  if (resolved.type !== "unionType") return null;
  const members = resolved.types;
  const kept = members.filter((m) => {
    const rm = safeResolveType(m, aliases);
    const propType =
      rm.type === "objectType"
        ? rm.properties.find((p) => p.key === prop)?.value
        : undefined;
    const match = propType ? literalTypeMatches(propType, literal, aliases) : "unknown";
    return keep ? match !== "no" : match !== "yes";
  });
  if (kept.length === members.length || kept.length === 0) return null;
  return kept.length === 1 ? kept[0] : { type: "unionType", types: kept };
}
```

Replace the `discriminant: () => null` placeholder in the `narrowers` table:

```ts
  discriminant: (r, current, aliases) =>
    narrowUnionByDiscriminant(current, r.prop, r.literal, r.keep, aliases),
```

- [ ] **Step 8: Run the e2e tests**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "discriminated-union narrowing"` — Expected: PASS (all).

- [ ] **Step 9: Full suite + tsc**

Run: `npx vitest run lib/typeChecker/ 2>&1 | tee /tmp/d1t2.log` — Expected: PASS.
Run: `npx tsc --noEmit` — Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add lib/typeChecker/literalType.ts lib/typeChecker/narrowing.ts lib/typeChecker/synthesizer.ts lib/typeChecker/narrowing.test.ts
git commit -F - <<'EOF'
feat(typechecker): discriminated-union narrowing on `v.prop == literal`

Recognize `v.prop ==/!= literal` over a bare variable; filter the union's
members via narrowUnionByDiscriminant (sound — drops only provably-excluded
members, never narrows to never). Reuses literal-type construction (new shared
literalToType, also used by synthType). Composes with !/&&/||/early-return/while.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Match-arm narrowing (D2) — confirm it's free

`match (r) { {kind:"answer", data} => use(data) }` lowers to `const __s = r; if (__s.kind == "answer") { const data = __s.data; … }`. Task 2's narrowing of `__s` types the binder — no new production code.

**Files:** Test `lib/typeChecker/narrowing.test.ts`; docs.

- [ ] **Step 1: Write the match-arm test (witnessing requires same-field/different-type)**

A field that exists on *one* member would type the same with or without narrowing (lenient union access). Use a field on *both* members with *different* types, and assert the **narrowed** message:

```ts
describe("discriminated-union narrowing — match arms", () => {
  it("types a bound field per arm via the narrowed temp", () => {
    const errs = check(`
type Reply = { kind: "answer", data: string } | { kind: "clarify", data: number }
def mkR(): Reply { return { kind: "answer", data: "x" } }
node main() {
  let r = mkR()
  match (r) {
    { kind: "answer", data } => { let n: number = data }
    { kind: "clarify", data } => { let s: string = data }
  }
}`);
    // Narrowed: answer.data is string (not string|number) → exact message.
    expect(errs).toContain("Type 'string' is not assignable to type 'number' (assignment to 'n').");
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 's').");
    // Guard against the non-test failure mode: the un-narrowed union message must NOT appear.
    expect(errs.some((e) => /string \| number|number \| string/.test(e))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — should already pass (free via Task 2)**

Run: `npx vitest run lib/typeChecker/narrowing.test.ts -t "match arms"` — Expected: PASS. The "free" premise was verified against `main`: `collectChecks` (`patternLowering.ts:606`) lowers a literal-valued object-pattern field to `makeBinOp(source, "==", literal)`, i.e. `__s.kind == "answer"`, which Step 4's recognizer matches. If it FAILS, there are two possible causes — (a) the lowered condition isn't a `v.prop == literal` the recognizer sees (inspect with `pnpm run ast`/preprocess on the match), or (b) the binder isn't reading the narrowed temp. Investigate either; do NOT add match-specific narrowing code.

- [ ] **Step 3: Docs + commit**

In `docs/dev/typechecker.md`, add a paragraph: discriminated-union narrowing (`v.prop == lit` narrows `v`; match arms narrow bound fields via the lowered temp); the two limitations (bound-fields-only; mixed unions with a non-literal discriminant member don't narrow). Opportunistically: the stale `synthesizer.ts:633-639` comment says "Until isSuccess/isFailure narrowing lands (Tier 2 PR B)…" — Result narrowing has landed; update that one line if convenient.

> **Deferred (was spec D2's binding hint):** a "bind it in the pattern" hint on unbound other-variant access is NOT in this plan. The correct (gated) version needs an `ObjectType` narrowing marker, which conflicts with `result-as-union` removing `narrowedBranch`; the unconditional version misfires on plain-object typos (reviews). Revisit after `result-as-union` settles the type-marker question.

```bash
git add lib/typeChecker/narrowing.test.ts docs/dev/typechecker.md
git commit -F - <<'EOF'
test(typechecker): match-arm discriminated-union narrowing is free via the temp

match arms narrow bound fields with no new code (Task 2 narrows the lowered
scrutinee temp; binders read it). Witnessed with a same-field/different-type
union so the test actually depends on narrowing. Docs updated.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage:** auto-detect discriminant (T2 recognizer); generalized candidate + declarative dispatch (T1, anti-patterns B); Form 1 then/else/!/&&/while/early-return (T2 e2e); Form 2 match arms free (T3); boolean/numeric/3-member/non-union/mixed coverage (T2); scope-leak + reassignment + control (T2); DRY literal types via `literalToType` (anti-patterns A); binding hint **deferred** with rationale.

**Placeholder scan:** none — complete code + commands throughout.

**Type consistency:** `Refine`/`NarrowCandidate`/`narrowers` (T1) consumed in T2's dispatch entry; `literalToType` / `narrowUnionByDiscriminant` / `literalTypeMatches` signatures consistent between definition and call sites; literal stored as `StringLiteralType|NumberLiteralType|BooleanLiteralType` everywhere (no `LiteralValue`).

**Risks:** (1) The `synthesizer.ts` refactor is **scoped to the string case only** — `number`/`boolean` keep returning `NUMBER_T`/`BOOLEAN_T`, because `synthType` does not produce numeric/boolean literal types today and changing that would regress inference (T2 Step 1, corrected after second review). The full `lib/typeChecker/` suite gates it. (2) Template-literal-no-holes coverage — verified/documented at T2 Step 1, not special-cased. (3) Witnessing tests depend on lenient union access (`synthValueAccess` union branch errors only when no member has the prop, `synthesizer.ts:648-672`); if `result-as-union` strict-access later changes it, these assertions need revisiting (noted). (4) Numeric/boolean narrowing depends on the type-annotation parser emitting literal types for `{ code: 1 }` / `{ ok: true }` — verified via `pnpm run ast`.
