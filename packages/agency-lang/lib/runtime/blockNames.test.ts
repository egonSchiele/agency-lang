import { describe, it, expect } from "vitest";
import { makeBlockName, isBlockName, isLiftedCallbackName } from "./blockNames.js";

describe("blockNames", () => {
  it("minted names are always recognized by the sibling predicate", () => {
    expect(isBlockName(makeBlockName(0))).toBe(true);
    expect(isBlockName(makeBlockName(42))).toBe(true);
  });

  it("rejects non-block shapes", () => {
    expect(isBlockName("__blockish")).toBe(false);
    expect(isBlockName("__block_")).toBe(false);
    expect(isBlockName("__block_1.5")).toBe(false);
    expect(isBlockName("__cb_main_0")).toBe(false);
  });

  it("minting refuses input the predicate could not recognize", () => {
    expect(() => makeBlockName(1.5)).toThrow("non-negative integer");
    expect(() => makeBlockName(-1)).toThrow("non-negative integer");
  });
});

describe("isLiftedCallbackName", () => {
  it("matches lifter-minted names", () => {
    expect(isLiftedCallbackName("__cb_main_0")).toBe(true);
    expect(isLiftedCallbackName("__cb_solveHardProblem_12")).toBe(true);
    expect(isLiftedCallbackName("__cb_top_3")).toBe(true);
  });

  it("rejects near-misses so user names keep the eager rename-detection throw", () => {
    expect(isLiftedCallbackName("__cbCache")).toBe(false);
    expect(isLiftedCallbackName("__cb_helper")).toBe(false); // no trailing counter
    expect(isLiftedCallbackName("__cb__0")).toBe(false); // empty scope segment
    expect(isLiftedCallbackName("cb_main_0")).toBe(false);
    expect(isLiftedCallbackName("__block_3")).toBe(false);
  });
});
