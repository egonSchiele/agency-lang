import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import { analyzeCondition, narrowToBranch } from "./narrowing.js";
import type { IfElse } from "../types.js";
import type { ResultType } from "../types/typeHints.js";

// Parse a snippet and pull the condition of the first `if` in `main`.
function firstIfCondition(body: string) {
  const src = `node main() {\n  let r = foo()\n  if (${body}) { }\n}`;
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  // walk to the ifElse node
  let cond: IfElse["condition"] | undefined;
  const visit = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === "ifElse") cond = n.condition;
      for (const k of ["body", "thenBody", "elseBody"]) if (Array.isArray(n[k])) visit(n[k]);
    }
  };
  visit(parsed.result.nodes);
  if (!cond) throw new Error("no if condition found");
  return cond;
}

const NO_FACTS = { then: [], else: [] };

describe("analyzeCondition", () => {
  it("isSuccess(r): then→success, else→failure", () => {
    expect(analyzeCondition(firstIfCondition("isSuccess(r)"))).toEqual({
      then: [{ variableName: "r", branch: "success" }],
      else: [{ variableName: "r", branch: "failure" }],
    });
  });

  it("isFailure(r): then→failure, else→success", () => {
    expect(analyzeCondition(firstIfCondition("isFailure(r)"))).toEqual({
      then: [{ variableName: "r", branch: "failure" }],
      else: [{ variableName: "r", branch: "success" }],
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
      then: [{ variableName: "r", branch: "failure" }],
      else: [{ variableName: "r", branch: "success" }],
    });
  });

  it("conjunction unions then-facts, drops else-facts", () => {
    expect(analyzeCondition(firstIfCondition("isSuccess(a) && isSuccess(b)"))).toEqual({
      then: [
        { variableName: "a", branch: "success" },
        { variableName: "b", branch: "success" },
      ],
      else: [],
    });
  });

  it("disjunction unions else-facts, drops then-facts", () => {
    expect(analyzeCondition(firstIfCondition("isFailure(a) || isFailure(b)"))).toEqual({
      then: [],
      else: [
        { variableName: "a", branch: "success" },
        { variableName: "b", branch: "success" },
      ],
    });
  });

  it("double negation is identity", () => {
    expect(analyzeCondition(firstIfCondition("!!isSuccess(r)"))).toEqual({
      then: [{ variableName: "r", branch: "success" }],
      else: [{ variableName: "r", branch: "failure" }],
    });
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
