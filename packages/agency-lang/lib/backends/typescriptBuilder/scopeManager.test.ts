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
