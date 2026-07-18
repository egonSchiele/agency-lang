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

describe("ScopeManager.enclosingDeclaredReturnType — stamped blocks (#580)", () => {
  const STR = { type: "primitiveType", value: "string" } as any;
  const NUM = { type: "primitiveType", value: "number" } as any;

  /** A ScopeManager whose compilationUnit knows one def and one node,
   *  each with an optional declared return. Only the fields the
   *  return-type lookups touch are stubbed. */
  const smWithDefs = (opts: { fnReturn?: any; nodeReturn?: any }) =>
    new ScopeManager({
      functionDefinitions: { f: { returnType: opts.fnReturn } },
      graphNodes: [{ nodeName: "main", returnType: opts.nodeReturn }],
    } as any);

  it("a stamped block answers its yield", () => {
    const m = smWithDefs({ fnReturn: undefined });
    m.push({ type: "function", functionName: "f" });
    m.push({ type: "block", blockName: "b1", declaredYieldType: STR });
    expect(m.enclosingDeclaredReturnType()).toEqual(STR);
  });

  it("an unstamped block defers to a stamped outer block", () => {
    const m = smWithDefs({ fnReturn: undefined });
    m.push({ type: "function", functionName: "f" });
    m.push({ type: "block", blockName: "outer", declaredYieldType: STR });
    m.push({ type: "block", blockName: "inner" });
    expect(m.enclosingDeclaredReturnType()).toEqual(STR);
  });

  it("an unstamped block defers to the function's declared return", () => {
    const m = smWithDefs({ fnReturn: STR });
    m.push({ type: "function", functionName: "f" });
    m.push({ type: "block", blockName: "b1" });
    expect(m.enclosingDeclaredReturnType()).toEqual(STR);
  });

  it("a stamped block under a node answers the stamp, not the node", () => {
    const m = smWithDefs({ nodeReturn: NUM });
    m.push({ type: "node", nodeName: "main" });
    m.push({ type: "block", blockName: "b1", declaredYieldType: STR });
    expect(m.enclosingDeclaredReturnType()).toEqual(STR);
  });
});
