import { describe, it, expect } from "vitest";
import { makeBlockName, isBlockName } from "./blockNames.js";

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
