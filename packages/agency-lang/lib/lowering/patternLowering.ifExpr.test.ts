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

function expectError(src: string, re: RegExp) {
  const parsed = parseAgency(src);
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.message).toMatch(re);
}

describe("if expression lowering", () => {
  it("assignment: lowers to a matchExprId-tagged IfElse + matchYields + consumer tag", () => {
    const body = lowerBody(`node main() {
  const label = if (true) { "A" } else { "B" }
  return label
}`);
    const ifNode = body.find(
      (n: any) => n.type === "ifElse" && n.matchExprId !== undefined,
    );
    expect(ifNode).toBeDefined();
    expect(ifNode.thenBody[0].type).toBe("matchYield");
    expect(ifNode.elseBody[0].type).toBe("matchYield");
    expect(ifNode.thenBody[0].matchId).toBe(ifNode.matchExprId);
    expect(ifNode.elseBody[0].matchId).toBe(ifNode.matchExprId);

    const consumer = body.find(
      (n: any) => n.type === "assignment" && n.variableName === "label",
    );
    expect(consumer.value.value).toBe(`__matchval_${ifNode.matchExprId}`);
    expect(consumer.matchExprSource.matchId).toBe(ifNode.matchExprId);
    // the tagged if-chain comes before its consumer
    expect(body.indexOf(ifNode)).toBeLessThan(body.indexOf(consumer));
  });

  it("return: `return if (...) { ... } else { ... }` hoists and returns the temp", () => {
    const body = lowerBody(`def f(x: boolean): string {
  return if (x) { "yes" } else { "no" }
}`);
    const ifNode = body.find(
      (n: any) => n.type === "ifElse" && n.matchExprId !== undefined,
    );
    expect(ifNode).toBeDefined();
    const ret = body[body.length - 1];
    expect(ret.type).toBe("returnStatement");
    expect(ret.value.value).toBe(`__matchval_${ifNode.matchExprId}`);
  });

  it("block branch with an explicit return yields, not a function return", () => {
    const body = lowerBody(`node main() {
  const v = if (true) {
    let n = 1
    return n
  } else {
    return 2
  }
  return v
}`);
    const ifNode = body.find(
      (n: any) => n.type === "ifElse" && n.matchExprId !== undefined,
    );
    expect(ifNode.thenBody.some((s: any) => s.type === "matchYield")).toBe(true);
    expect(ifNode.thenBody.some((s: any) => s.type === "returnStatement")).toBe(false);
  });

  it("else if chain: every branch yields into the one owning match id", () => {
    const body = lowerBody(`node main(x: string) {
  const label = if (x == "a") { "A" } else if (x == "b") { "B" } else { "C" }
  return label
}`);
    const top = body.find(
      (n: any) => n.type === "ifElse" && n.matchExprId !== undefined,
    );
    expect(top).toBeDefined();
    const id = top.matchExprId;
    // then yields
    expect(top.thenBody[0].type).toBe("matchYield");
    expect(top.thenBody[0].matchId).toBe(id);
    // else is a nested if (the else-if), NOT separately tagged, whose branches
    // yield into the SAME id
    const nested = top.elseBody[0];
    expect(nested.type).toBe("ifElse");
    expect(nested.matchExprId).toBeUndefined();
    expect(nested.thenBody[0].type).toBe("matchYield");
    expect(nested.thenBody[0].matchId).toBe(id);
    expect(nested.elseBody[0].type).toBe("matchYield");
    expect(nested.elseBody[0].matchId).toBe(id);
  });

  it("missing else in expression position is an error", () =>
    expectError(
      `node main() {\n  const label = if (true) { "A" }\n  return label\n}`,
      /else|must return a value/i,
    ));

  it("a branch that does not yield on every path is an error", () =>
    // A `let` (not an expression) makes the branch fall off the end without
    // yielding — like a match arm `_ => { let y = 1 }`.
    expectError(
      `node main() {\n  const label = if (true) { let y = 1 } else { "B" }\n  return label\n}`,
      /must return a value/i,
    ));

  it("return inside a parallel block in an if-expression branch is rejected", () =>
    expectError(
      `node main() {\n  const label = if (true) {\n    parallel {\n      return "x"\n    }\n  } else { "B" }\n  return label\n}`,
      /parallel/i,
    ));
});
