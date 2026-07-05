import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

// The lowered body of the LAST function/graph node (skips any leading helper
// `def` so tests can call one from the node/function that holds the if-expr).
function bodyOf(src: string): any[] {
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(parsed.message);
  const defs = (parsed.result.nodes as any[]).filter(
    (n) => n.type === "graphNode" || n.type === "function",
  );
  return defs[defs.length - 1].body;
}

// The whole point of the design: `if c then a else b` lowers to the SAME stepped
// `ifElse` machinery a `match` expression uses (a `matchExprId`-tagged `ifElse`
// whose branches `matchYield`), NOT a ternary. That stepping is what makes
// interrupts work inside a branch (locked by the execution fixture). These tests
// pin the lowered shape so a regression back to a non-stepped form fails here.
describe("if-expression lowering (stepped, match-expression machinery)", () => {
  it("lowers to a matchExprId-tagged ifElse whose branches yield, + a tagged consumer", () => {
    const body = bodyOf(`node main(c: boolean) {
  const label = if c then "yes" else "no"
  return label
}`);
    const ifNode = body.find(
      (n: any) => n.type === "ifElse" && n.matchExprId !== undefined,
    );
    expect(ifNode).toBeDefined();
    // Each branch ends in a matchYield into the owning id (via a temp binding,
    // so a branch call is compiled at statement position — see fixture).
    const thenYield = ifNode.thenBody.find((s: any) => s.type === "matchYield");
    const elseYield = ifNode.elseBody.find((s: any) => s.type === "matchYield");
    expect(thenYield.matchId).toBe(ifNode.matchExprId);
    expect(elseYield.matchId).toBe(ifNode.matchExprId);

    // The consumer reads the __matchval_<id> temp and is tagged matchExprSource
    // so the type checker union-types it.
    const decl = body.find(
      (n: any) => n.type === "assignment" && n.variableName === "label",
    );
    expect(decl.value.value).toBe(`__matchval_${ifNode.matchExprId}`);
    expect(decl.matchExprSource.matchId).toBe(ifNode.matchExprId);
  });

  it("a branch is bound to a temp at statement position (so calls propagate interrupts)", () => {
    const body = bodyOf(`def f(): number { return 1 }
node main(c: boolean) {
  const x = if c then f() else 0
  return x
}`);
    const ifNode = body.find(
      (n: any) => n.type === "ifElse" && n.matchExprId !== undefined,
    );
    // then-branch: a temp binding (statement) THEN a yield of that temp — not a
    // bare `matchYield(f())`, which would swallow an interrupt from f().
    expect(ifNode.thenBody[0].type).toBe("assignment");
    expect(ifNode.thenBody[1].type).toBe("matchYield");
    expect(ifNode.thenBody[1].value.value).toBe(ifNode.thenBody[0].variableName);
  });

  it("`return if ...` hoists the region and returns the temp", () => {
    const body = bodyOf(`def f(x: boolean): string {
  return if x then "yes" else "no"
}`);
    const ifNode = body.find(
      (n: any) => n.type === "ifElse" && n.matchExprId !== undefined,
    );
    const ret = body[body.length - 1];
    expect(ret.type).toBe("returnStatement");
    expect(ret.value.value).toBe(`__matchval_${ifNode.matchExprId}`);
  });
});
