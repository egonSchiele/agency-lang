import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

function lowerBody(src: string): any[] {
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(parsed.message);
  const main: any = parsed.result.nodes.find(
    (n: any) => n.type === "graphNode" || n.type === "function",
  );
  return main.body;
}

describe("expression match lowering", () => {
  it("literal arms: temp + tagged match + consumer with matching ids", () => {
    const body = lowerBody(`node main() {
  const val = match("a") {
    "a" => 1
    _ => 2
  }
  return val
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    expect(matchStmt.matchExprId).toBeTypeOf("number");
    const arm = matchStmt.cases.find((c: any) => c.type === "matchBlockCase");
    expect(arm.body[0].type).toBe("matchYield");
    expect(arm.body[0].matchId).toBe(matchStmt.matchExprId);
    expect(arm.body[0].value).toEqual(expect.objectContaining({ type: "number", value: "1" }));
    const assign = body.find((n: any) => n.type === "assignment" && n.variableName === "val");
    expect(assign.value.value).toBe(`__matchval_${matchStmt.matchExprId}`);
    expect(assign.matchExprSource.matchId).toBe(matchStmt.matchExprId);
    expect(body.indexOf(matchStmt)).toBeLessThan(body.indexOf(assign));
  });

  it("rewrites return in block arms to matchYield with the right value", () => {
    const body = lowerBody(`node main() {
  const val = match("a") {
    "a" => {
      print("hi")
      return 1
    }
    _ => 2
  }
  return val
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    const arm = matchStmt.cases.find((c: any) => c.type === "matchBlockCase");
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(y.value).toEqual(expect.objectContaining({ type: "number", value: "1" }));
    expect(arm.body.some((s: any) => s.type === "returnStatement")).toBe(false);
  });

  it("return match(...) lowers to statements-then-return of the temp", () => {
    const body = lowerBody(`def f(x: string): number {
  return match(x) {
    "a" => 1
    _ => 2
  }
}`);
    const ret = body[body.length - 1];
    expect(ret.type).toBe("returnStatement");
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    expect(ret.value.value).toBe(`__matchval_${matchStmt.matchExprId}`);
  });

  it("pattern arms: scrutinee hoisted once, before the tagged chain", () => {
    const body = lowerBody(`node main(r: Result) {
  const val = match(r) {
    success(v) => v
    failure(e) => 0
  }
  return val
}`);
    const scrutinee = body.find((n: any) => n.type === "assignment" && n.matchSource);
    const chain = body.find((n: any) => n.type === "ifElse");
    expect(scrutinee.matchExprId).toBeTypeOf("number");
    expect(chain.matchExprId).toBe(scrutinee.matchExprId);
    expect(body.indexOf(scrutinee)).toBeLessThan(body.indexOf(chain));
  });

  it("guarded arms in expression position lower and yield", () => {
    const body = lowerBody(`node main(x: any) {
  const val = match(x) {
    { kind: "n", v } if (v > 0) => v
    _ => 0
  }
  return val
}`);
    expect(body.some((n: any) => n.matchExprId !== undefined)).toBe(true);
  });

  it("nested return match(...) inside an arm lowers inner-first", () => {
    const body = lowerBody(`node main(x: string) {
  const val = match(x) {
    "a" => {
      return match(x) {
        "a" => 1
        _ => 2
      }
    }
    _ => 3
  }
  return val
}`);
    const outer = body.find((n: any) => n.type === "matchBlock" && n.matchExprId !== undefined);
    const arm = outer.cases.find((c: any) => c.type === "matchBlockCase");
    // arm body: [ ...inner lowered statements..., matchYield(varRef __matchval_inner) ]
    const inner = arm.body.find((s: any) => s.type === "matchBlock" && s.matchExprId !== undefined);
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(inner.matchExprId).not.toBe(outer.matchExprId);
    expect(y.matchId).toBe(outer.matchExprId);
    expect(y.value.value).toBe(`__matchval_${inner.matchExprId}`);
    expect(arm.body.indexOf(inner)).toBeLessThan(arm.body.indexOf(y));
  });

  it("const x = match(...) inside an arm body lowers via recursion", () => {
    const body = lowerBody(`node main(x: string) {
  const val = match(x) {
    "a" => {
      const inner = match(x) {
        "a" => 1
        _ => 2
      }
      return inner
    }
    _ => 3
  }
  return val
}`);
    const outer = body.find((n: any) => n.type === "matchBlock" && n.matchExprId !== undefined);
    const arm = outer.cases.find((c: any) => c.type === "matchBlockCase");
    // The nested `const inner = match(...)` must have lowered via lowerAssignment
    // recursion: an inner tagged match, then an assignment of the inner temp,
    // then a matchYield of `inner`.
    const innerMatch = arm.body.find(
      (s: any) => s.type === "matchBlock" && s.matchExprId !== undefined,
    );
    expect(innerMatch).toBeDefined();
    const innerAssign = arm.body.find(
      (s: any) => s.type === "assignment" && s.variableName === "inner",
    );
    expect(innerAssign.matchExprSource.matchId).toBe(innerMatch.matchExprId);
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(y.matchId).toBe(outer.matchExprId);
  });
});

describe("expression match lowering errors", () => {
  function expectError(src: string, re: RegExp) {
    const parsed = parseAgency(src);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.message).toMatch(re);
  }
  const WRAP = (arm: string) => `node main(x: any) {
  const val = match(x) {
    ${arm}
    _ => 2
  }
  return val
}`;

  it("if without else does not yield on all paths", () =>
    expectError(WRAP(`"a" => {\n      if (true) { return 1 }\n    }`), /must return a value/i));
  it("if with non-yielding else errors", () =>
    expectError(WRAP(`"a" => {\n      if (true) { return 1 } else { print("no") }\n    }`), /must return a value/i));
  it("if with both branches yielding passes", () => {
    const parsed = parseAgency(WRAP(`"a" => {\n      if (true) { return 1 } else { return 2 }\n    }`));
    expect(parsed.success).toBe(true);
  });
  it("trailing yield after a non-yielding if passes", () => {
    const parsed = parseAgency(WRAP(`"a" => {\n      if (true) { return 1 }\n      return 2\n    }`));
    expect(parsed.success).toBe(true);
  });
  it("loop-only return does not count (syntactic rule)", () =>
    expectError(WRAP(`"a" => {\n      for (i in x) { return 1 }\n    }`), /must return a value/i));
  it("empty block arm errors", () =>
    expectError(WRAP(`"a" => { }`), /must return a value/i));
  it("assignment is not mistaken for a yield", () =>
    expectError(WRAP(`"a" => {\n      let y = 1\n    }`), /must return a value/i));
  it("bare return errors", () =>
    expectError(WRAP(`"a" => { return }`), /must return a value/i));
  it("return inside parallel in an arm errors", () =>
    expectError(WRAP(`"a" => {\n      parallel {\n        return 1\n      }\n    }`), /parallel|concurrency/i));
  it("match(x is ...) in expression position errors", () =>
    expectError(`node main(x: any) {\n  const val = match(x is { k }) {\n    _ => 2\n  }\n  return val\n}`, /cannot be used as an expression/i));
  it("module-level match expression errors", () =>
    expectError(`const g = match("a") {\n  "a" => 1\n  _ => 2\n}\nnode main() { return g }`, /module-level|top-level/i));
});
