import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import { analyzeCondition, narrowToBranch, alwaysExits, postGuardFacts } from "./narrowing.js";
import { walkNodes } from "../utils/node.js";
import type { Expression, IfElse } from "../types.js";
import type { ResultType } from "../types/typeHints.js";

// Parse a snippet and return the first ifElse node in main. Uses the shared
// walkNodes traversal (lib/utils/node.ts) rather than a hand-rolled walker —
// see docs/dev/anti-patterns.md "Duplicating existing code".
function firstIf(srcBody: string): IfElse {
  const parsed = parseAgency(`node main() {\n${srcBody}\n}`);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  for (const { node } of walkNodes(parsed.result.nodes)) {
    if (node.type === "ifElse") return node;
  }
  throw new Error("no ifElse found");
}

const firstIfCondition = (cond: string) => firstIf(`if (${cond}) { }`).condition;

const NO_FACTS = { then: [], else: [] };

describe("analyzeCondition", () => {
  it("isSuccess(r): then→success, else→failure", () => {
    expect(analyzeCondition(firstIfCondition("isSuccess(r)"))).toEqual({
      then: [{ variableName: "r", refine: { kind: "resultBranch", branch: "success" } }],
      else: [{ variableName: "r", refine: { kind: "resultBranch", branch: "failure" } }],
    });
  });

  it("isFailure(r): then→failure, else→success", () => {
    expect(analyzeCondition(firstIfCondition("isFailure(r)"))).toEqual({
      then: [{ variableName: "r", refine: { kind: "resultBranch", branch: "failure" } }],
      else: [{ variableName: "r", refine: { kind: "resultBranch", branch: "success" } }],
    });
  });

  // One parametrized block covers every early-return branch in analyzeCondition.
  // If any of these starts producing candidates, the test fails immediately —
  // which is what we want, because each would mean we're narrowing a site we
  // can't statically prove is the same variable at runtime.
  it.each([
    ["non-functionCall condition", "r == 1"],
    ["unrelated function call", "foo(r)"],
    ["isSuccess with zero args", "isSuccess()"],
    ["isSuccess with too many args", "isSuccess(r, r)"],
    ["isSuccess of a non-variable", "isSuccess(tryParse(\"x\"))"],
    ["isSuccess of a member access", "isSuccess(o.r)"],
  ])("produces no candidates for %s", (_label, src) => {
    expect(analyzeCondition(firstIfCondition(src))).toEqual(NO_FACTS);
  });

  it("negation swaps then/else", () => {
    expect(analyzeCondition(firstIfCondition("!isSuccess(r)"))).toEqual({
      then: [{ variableName: "r", refine: { kind: "resultBranch", branch: "failure" } }],
      else: [{ variableName: "r", refine: { kind: "resultBranch", branch: "success" } }],
    });
  });

  it("conjunction unions then-facts, drops else-facts", () => {
    expect(analyzeCondition(firstIfCondition("isSuccess(a) && isSuccess(b)"))).toEqual({
      then: [
        { variableName: "a", refine: { kind: "resultBranch", branch: "success" } },
        { variableName: "b", refine: { kind: "resultBranch", branch: "success" } },
      ],
      else: [],
    });
  });

  it("disjunction unions else-facts, drops then-facts", () => {
    expect(analyzeCondition(firstIfCondition("isFailure(a) || isFailure(b)"))).toEqual({
      then: [],
      else: [
        { variableName: "a", refine: { kind: "resultBranch", branch: "success" } },
        { variableName: "b", refine: { kind: "resultBranch", branch: "success" } },
      ],
    });
  });

  it("double negation is identity", () => {
    expect(analyzeCondition(firstIfCondition("!!isSuccess(r)"))).toEqual({
      then: [{ variableName: "r", refine: { kind: "resultBranch", branch: "success" } }],
      else: [{ variableName: "r", refine: { kind: "resultBranch", branch: "failure" } }],
    });
  });

  const disc = (keep: boolean, value = "answer", prop = "kind") => ({
    variableName: "r",
    refine: { kind: "discriminant", prop, literal: { type: "stringLiteralType", value }, keep },
  });

  it.each([
    ['r.kind == "answer"', true, false],
    ['"answer" == r.kind', true, false], // operand swap
    ['r.kind != "answer"', false, true],
    ['"answer" != r.kind', false, true], // operand swap, !=
  ])("recognizes %s", (src, thenKeep, elseKeep) => {
    const f = analyzeCondition(firstIfCondition(src));
    expect(f.then[0]).toEqual(disc(thenKeep));
    expect(f.else[0]).toEqual(disc(elseKeep));
  });

  it("recognizes numeric and boolean discriminants", () => {
    expect(analyzeCondition(firstIfCondition("n.code == 1")).then[0].refine).toEqual({
      kind: "discriminant",
      prop: "code",
      literal: { type: "numberLiteralType", value: "1" },
      keep: true,
    });
    expect(analyzeCondition(firstIfCondition("r.ok == true")).then[0].refine).toEqual({
      kind: "discriminant",
      prop: "ok",
      literal: { type: "booleanLiteralType", value: "true" },
      keep: true,
    });
  });

  it.each([
    "r.kind == s.kind", // both member access
    "x == 1", // no member access
    'r.a.kind == "x"', // nested member — out of scope
    "r.kind == r.text", // same var both sides, no literal
    "r.kind == undefined", // undefined is a variableName, not a literal
  ])("produces no candidates for %s", (src) => {
    expect(analyzeCondition(firstIfCondition(src))).toEqual({ then: [], else: [] });
  });

  it("composes ! with a discriminant (swaps then/else)", () => {
    // Agency has no `!(expr)` syntax, so build the negation directly: the parser
    // desugars `!x` to a binOp { operator:"!", left:<true>, right:x }. This
    // proves the generic `!` swap composes with discriminant facts.
    const inner = firstIfCondition('r.kind == "answer"');
    const negated: Expression = {
      type: "binOpExpression",
      operator: "!",
      left: { type: "boolean", value: true },
      right: inner,
    };
    const f = analyzeCondition(negated);
    expect(f.then).toEqual([disc(false)]); // !(== answer) → then is the complement
    expect(f.else).toEqual([disc(true)]);
  });
});

describe("narrowToBranch", () => {
  const rt: ResultType = {
    type: "resultType",
    successType: { type: "primitiveType", value: "number" },
    failureType: { type: "primitiveType", value: "string" },
  };

  it.each(["success", "failure"] as const)("tags a copy as %s without mutating the original", (branch) => {
    const narrowed = narrowToBranch(rt, branch);
    expect(narrowed.narrowedBranch).toBe(branch);
    expect(narrowed.successType).toEqual(rt.successType);
    expect(narrowed.failureType).toEqual(rt.failureType);
    expect(rt.narrowedBranch).toBeUndefined();
  });

  it("re-narrowing replaces the previous branch rather than stacking", () => {
    // Inside `if (isSuccess(r)) { if (isFailure(r)) { ... } }`, the inner
    // re-narrow must overwrite, not append, or downstream synthesis sees
    // a stale branch tag.
    const onceSuccess = narrowToBranch(rt, "success");
    const reFailure = narrowToBranch(onceSuccess, "failure");
    expect(reFailure.narrowedBranch).toBe("failure");
  });
});

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

const TRY_PARSE = `
def tryParse(input: string): Result<number, string> {
  if (input == "ok") { return success(42) }
  return failure("bad")
}
`;

describe("Result narrowing — isSuccess then-branch", () => {
  it("narrows r.value to the success type inside an isSuccess guard", () => {
    // r.value is `number` once narrowed, so assigning it to a `string` must error.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) {
    let n: string = r.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("types the binding from the lowered `is success(v)` form", () => {
    // if (r is success(v)) lowers to: if (isSuccess(r)) { const v = r.value; ... }
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (r is success(v)) {
    let n: string = v
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("skips narrowing when the variable is reassigned in the branch (soundness gate)", () => {
    // Self-witnessing: `safeR` proves narrowing IS firing in this run; `reassignedR`
    // proves the gate fired for the reassignment case. If narrowing breaks entirely,
    // the `safeR` assertion fails — preventing the "passes silently when broken" trap
    // a plain `.not.toContain` would have.
    const errs = check(`${TRY_PARSE}
node main() {
  let safeR = tryParse("ok")
  let reassignedR = tryParse("ok")
  if (isSuccess(safeR)) {
    let safe: string = safeR.value
  }
  if (isSuccess(reassignedR)) {
    reassignedR = tryParse("again")
    let unsafe: string = reassignedR.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'safe').");
    expect(errs).not.toContain("(assignment to 'unsafe')");
  });

  it("narrows inside the guard but does NOT leak past it", () => {
    // Self-witnessing pair: `inside` proves narrowing fires inside the block;
    // `after` proves it doesn't escape. Either half failing diagnoses the bug.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) {
    let inside: string = r.value
  }
  let after: string = r.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'inside').");
    expect(errs).not.toContain("(assignment to 'after')");
  });

  it("threads non-narrowing typecheck errors through the narrowed body", () => {
    // walkWithNarrowing passes ctx through to the inner walk; if ctx is dropped
    // or replaced, errors inside narrowed bodies vanish. This locks that wiring.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) {
    let s: string = 42
  }
}`);
    expect(errs.some((e) => /not assignable/.test(e) && /'s'/.test(e))).toBe(true);
  });

  it("narrows a function parameter, not just a let-bound local", () => {
    // Parameters live on the function scope (declared at call-frame setup),
    // not via a let-style declaration. The lookup path differs; a regression
    // that restricts narrowing to let-bindings would slip past every other test.
    const errs = check(`${TRY_PARSE}
def consume(r: Result<number, string>) {
  if (isSuccess(r)) {
    let n: string = r.value
  }
}
node main() { consume(tryParse("ok")) }`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("does NOT propagate the narrowing marker through a let-binding past the block", () => {
    // `scope.declare()` calls `widenType()` on the inferred RHS, and
    // `widenType` for `resultType` (assignability.ts) constructs a fresh
    // object that does NOT copy `narrowedBranch`. So `let r2 = r` inside
    // an isSuccess guard gives `r2` a clean ResultType, and `r2.value`
    // outside the block stays `any` (the un-narrowed default).
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  let r2: Result<number, string> = failure("init")
  if (isSuccess(r)) {
    r2 = r
  }
  let outside: string = r2.value
}`);
    expect(errs).not.toContain("(assignment to 'outside')");
  });

  it("narrows an alias-typed Result (resolves the alias before the resultType check)", () => {
    // Variables annotated with a type alias (`let r: R = ...` where
    // `type R = Result<...>`) are stored in the scope as a
    // `typeAliasVariable`, not a `resultType`. `applyNarrowing` must
    // resolve through the alias so the narrowing fires — otherwise it
    // silently doesn't, and Increment 3's hard-error flip would leave
    // alias-typed Results un-narrowable (user adds the guard, still errors).
    const errs = check(`${TRY_PARSE}
type R = Result<number, string>

node main() {
  let r: R = tryParse("ok")
  if (isSuccess(r)) {
    let n: string = r.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("narrows independently in nested isSuccess guards", () => {
    // Locks that scope chaining narrows two different variables across two
    // nested guards. Catches a regression where the inner walkWithNarrowing
    // accidentally shadows / replaces the outer narrowing.
    const errs = check(`${TRY_PARSE}
node main() {
  let r1 = tryParse("ok")
  let r2 = tryParse("ok")
  if (isSuccess(r1)) {
    if (isSuccess(r2)) {
      let a: string = r1.value
      let b: string = r2.value
    }
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'a').");
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'b').");
  });
});

describe("Result narrowing — failure branch", () => {
  it("narrows r.error to the failure type in the else of an isSuccess guard", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) { } else {
    let n: number = r.error
  }
}`);
    // r.error is `string` once narrowed → assigning to `number` must error.
    expect(errs).toContain("Type 'string' is not assignable to type 'number' (assignment to 'n').");
  });

  it("narrows r.error to the failure type inside an isFailure guard", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isFailure(r)) {
    let n: number = r.error
  }
}`);
    expect(errs).toContain("Type 'string' is not assignable to type 'number' (assignment to 'n').");
  });

  it("types the binding from the lowered `is failure(e)` form", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (r is failure(e)) {
    let n: number = e
  }
}`);
    expect(errs).toContain("Type 'string' is not assignable to type 'number' (assignment to 'n').");
  });
});

describe("Result narrowing — while and match", () => {
  it("narrows r.value inside a while body and respects the reassignment gate", () => {
    // Self-witnessing pair in one body: `safe` proves the while-body narrowing
    // wiring fires; `unsafe` proves the soundness gate still triggers when the
    // loop body reassigns its scrutinee. If narrowing breaks completely, the
    // `safe` assertion fails — no silent-pass trap.
    const errs = check(`${TRY_PARSE}
node main() {
  let safeR = tryParse("ok")
  while (isSuccess(safeR)) {
    let safe: string = safeR.value
    break
  }
  let unsafeR = tryParse("ok")
  while (isSuccess(unsafeR)) {
    let unsafe: string = unsafeR.value
    unsafeR = tryParse("again")
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'safe').");
    expect(errs).not.toContain("(assignment to 'unsafe')");
  });

  it("types the binding from a match success arm", () => {
    // Match arm bodies are a single expression, so we surface the narrowed
    // binding type by calling a helper whose parameter type mismatches it.
    // `expectString` takes a `string`; passing a narrowed-to-`number` `v`
    // produces an argument-type error iff narrowing flowed into the arm.
    const errs = check(`${TRY_PARSE}
def expectString(s: string) {}

node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => expectString(v)
    failure(e) => 0
  }
}`);
    expect(errs.some((e) => /not assignable/.test(e))).toBe(true);
  });

  it("types the binding from a match failure arm", () => {
    // Symmetric to the success-arm test. The failure arm lowers through a
    // different path inside `lowerMatchBlock` (`isFailure(_temp)` guard +
    // `const e = _temp.error` binding); a regression that breaks only the
    // failure-arm lowering would slip past the success-arm test alone.
    const errs = check(`${TRY_PARSE}
def expectNumber(n: number) {}

node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => 0
    failure(e) => expectNumber(e)
  }
}`);
    expect(errs.some((e) => /not assignable/.test(e))).toBe(true);
  });
});

describe("Result narrowing — combinators", () => {
  it("narrows both branches of an isSuccess else via negation", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (!isSuccess(r)) {
    let e: number = r.error
  } else {
    let v: string = r.value
  }
}`);
    expect(errs).toContain("Type 'string' is not assignable to type 'number' (assignment to 'e').");
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'v').");
  });

  it("narrows every conjunct in an && guard", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let a = tryParse("ok")
  let b = tryParse("ok")
  if (isSuccess(a) && isSuccess(b)) {
    let x: string = a.value
    let y: string = b.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'x').");
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'y').");
  });
});

describe("alwaysExits", () => {
  it("true when the body has a top-level return", () => {
    expect(alwaysExits(firstIf(`  if (isFailure(r)) { return 0 }`).thenBody)).toBe(true);
  });
  it("false when the body has no return", () => {
    expect(alwaysExits(firstIf(`  if (isFailure(r)) { let x = 1 }`).thenBody)).toBe(false);
  });
  it("true when both arms of a nested if return", () => {
    const node = firstIf(`  if (isFailure(r)) { if (x) { return 1 } else { return 2 } }`);
    expect(alwaysExits(node.thenBody)).toBe(true);
  });
  it("false when only one arm of a nested if returns", () => {
    const node = firstIf(`  if (isFailure(r)) { if (x) { return 1 } }`);
    expect(alwaysExits(node.thenBody)).toBe(false);
  });
});

describe("postGuardFacts", () => {
  it("then-exits, no else → else-facts apply after", () => {
    const node = firstIf(`  if (isFailure(r)) { return 0 }`);
    expect(postGuardFacts(node, analyzeCondition(node.condition))).toEqual([
      { variableName: "r", refine: { kind: "resultBranch", branch: "success" } },
    ]);
  });
  it("neither branch exits → no facts after", () => {
    const node = firstIf(`  if (isFailure(r)) { let x = 1 }`);
    expect(postGuardFacts(node, analyzeCondition(node.condition))).toEqual([]);
  });
});

describe("Result narrowing — early-return guards", () => {
  it("narrows after `if (isFailure(r)) { return }`", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isFailure(r)) { return 0 }
  let n: string = r.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("narrows after a negated early-return guard", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (!isSuccess(r)) { return 0 }
  let n: string = r.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("narrows after an else-only exit", () => {
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) { } else { return 0 }
  let n: string = r.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("does NOT narrow after a non-exiting guard but DOES after an exiting one", () => {
    // Self-witnessing: `exiting.value` proves post-guard narrowing IS firing
    // in this run; `merged.value` proves it correctly skips when the guard
    // doesn't always exit. If post-guard wiring breaks entirely, the `exiting`
    // assertion fails — no silent-pass trap.
    const errs = check(`${TRY_PARSE}
node main() {
  let exiting = tryParse("ok")
  if (isFailure(exiting)) { return 0 }
  let e: string = exiting.value

  let merged = tryParse("ok")
  if (isFailure(merged)) { let x = 1 }
  let m: string = merged.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'e').");
    expect(errs).not.toContain("(assignment to 'm')");
  });

  it("respects the reassignment gate in the post-guard region", () => {
    // Self-witnessing pair: `safe` proves post-guard narrowing fires;
    // `unsafe` proves the reassignment gate fires when the post-guard tail
    // reassigns the variable. Breaking narrowing entirely fails the `safe`
    // assertion.
    const errs = check(`${TRY_PARSE}
node main() {
  let safeR = tryParse("ok")
  if (isFailure(safeR)) { return 0 }
  let safe: string = safeR.value

  let unsafeR = tryParse("ok")
  if (isFailure(unsafeR)) { return 0 }
  unsafeR = tryParse("again")
  let unsafe: string = unsafeR.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'safe').");
    expect(errs).not.toContain("(assignment to 'unsafe')");
  });

  it("narrows after a chain of early-return guards", () => {
    // Locks that the recursive tail-walk correctly produces nested narrowings
    // — two sequential early-return guards must each narrow a different
    // variable for the rest of the body.
    const errs = check(`${TRY_PARSE}
node main() {
  let a = tryParse("ok")
  let b = tryParse("ok")
  if (isFailure(a)) { return 0 }
  if (isFailure(b)) { return 0 }
  let x: string = a.value
  let y: string = b.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'x').");
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'y').");
  });

  it("emits no post-guard facts when both branches exit", () => {
    // postGuardFacts returns [] when both arms exit (after-code is dead).
    // The dead `m.value` access must NOT narrow (no facts to apply) — but
    // we still need a self-witness that post-guard narrowing exists, so
    // pair with `e` from an exiting-then-only guard in the same body.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (isFailure(r)) { return 0 }
  let e: string = r.value

  let m = tryParse("ok")
  if (isSuccess(m)) { return 1 } else { return 2 }
  let dead: string = m.value
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'e').");
    expect(errs).not.toContain("(assignment to 'dead')");
  });

  it("post-guard narrowing applies inside an outer if's body", () => {
    // The index-loop change must work at every nesting depth, not just
    // top-level. An inner early-return guard inside an outer if's then-body
    // must still narrow the tail of THAT body.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  if (true) {
    if (isFailure(r)) { return 0 }
    let n: string = r.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });
});

describe("Result narrowing — || end-to-end", () => {
  it("narrows in the else of an || guard via the union of else-facts", () => {
    // If `isFailure(r) || other` is false in the else, then specifically
    // `isFailure(r)` is false → `r` is Success in the else-branch. The
    // disjunction-rule `else = else(l) ∪ else(r)` produces that fact.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  let other = tryParse("ok")
  if (isFailure(r) || isFailure(other)) {
  } else {
    let n: string = r.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'n').");
  });

  it("does NOT narrow in the then-branch of an || guard (soundness)", () => {
    // `then: []` for disjunctions — either disjunct could be the true one,
    // so we can't pin `r`. Pair with an end-to-end `&&` then-branch assertion
    // in the same body to witness that narrowing IS otherwise functional.
    const errs = check(`${TRY_PARSE}
node main() {
  let r = tryParse("ok")
  let other = tryParse("ok")
  if (isSuccess(r) || isSuccess(other)) {
    let n: string = r.value
  }
  if (isSuccess(r) && isSuccess(other)) {
    let w: string = r.value
  }
}`);
    expect(errs).toContain("Type 'number' is not assignable to type 'string' (assignment to 'w').");
    expect(errs).not.toContain("(assignment to 'n')");
  });
});

const REPLY = `
type Reply = { kind: "answer", text: string } | { kind: "clarify", question: string }
def mk(): Reply { return { kind: "answer", text: "x" } }
`;
const has = (errs: string[], re: RegExp) => errs.filter((e) => re.test(e)).length;
// Anchor on the `Property 'X' does not exist` access error specifically — a
// looser regex spuriously matches the *other* member's field name as rendered
// inside the type (`… on type '{ kind: "clarify", question: string }'`).
const noQuestion = /Property 'question' does not exist/;
const noText = /Property 'text' does not exist/;

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

  it("composes with && (then-facts union)", () => {
    const andErrs = check(`${REPLY}
node main() {
  let r = mk()
  if (r.kind == "answer" && true) { let q = r.question }
}`);
    expect(has(andErrs, noQuestion)).toBe(1);
    // NOTE: `!` composition is covered by the analyzeCondition unit test
    // "composes ! with a discriminant" rather than e2e — Agency has no
    // `!(expr)` syntax (the parser rejects a `!` before a parenthesized
    // group), so `!(r.kind == "answer")` is not expressible in source.
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

describe("discriminated-union narrowing — match arms", () => {
  it("types a bound field per arm via the narrowed temp", () => {
    const errs = check(`
type Reply = { kind: "answer", data: string } | { kind: "clarify", data: number }
def mkR(): Reply { return { kind: "answer", data: "x" } }
node main() {
  let r = mkR()
  match (r) {
    { kind: "answer", data } => let n: number = data
    { kind: "clarify", data } => let s: string = data
  }
}`);
    // Narrowed per arm: answer.data is `string`, clarify.data is `number` —
    // each exact, not the `string | number` union. (Substring `.some` rather
    // than `toContain`: the assignment-context suffix "(assignment to 'x')" is
    // only emitted for the first arm's lowered position, not the else arm —
    // a cosmetic message detail, irrelevant to the narrowing under test.)
    expect(errs.some((e) => e.includes("Type 'string' is not assignable to type 'number'"))).toBe(
      true,
    );
    expect(errs.some((e) => e.includes("Type 'number' is not assignable to type 'string'"))).toBe(
      true,
    );
    // Guard against the non-test failure mode: the un-narrowed union message must NOT appear.
    expect(errs.some((e) => /string \| number|number \| string/.test(e))).toBe(false);
  });
});
