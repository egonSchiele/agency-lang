import { describe, it, expect } from "vitest";
import { interrupt, hasInterrupts } from "./interrupts.js";

describe("hasInterrupts", () => {
  it("returns true for an array of interrupts", () => {
    const interrupts = [
      interrupt({ kind: "unknown", message: "test1", data: {}, origin: "", runId: "run1" }),
      interrupt({ kind: "unknown", message: "test2", data: {}, origin: "", runId: "run1" }),
    ];
    expect(hasInterrupts(interrupts)).toBe(true);
  });

  it("returns true for a single-element array", () => {
    expect(hasInterrupts([interrupt({ kind: "unknown", message: "test", data: {}, origin: "", runId: "run1" })])).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(hasInterrupts(null)).toBe(false);
    expect(hasInterrupts(undefined)).toBe(false);
  });

  it("returns false for a non-array", () => {
    expect(hasInterrupts("hello")).toBe(false);
    expect(hasInterrupts({ type: "interrupt" })).toBe(false);
  });

  it("returns false for an empty array", () => {
    expect(hasInterrupts([])).toBe(false);
  });

  it("returns false for an array of non-interrupts", () => {
    expect(hasInterrupts([1, 2, 3])).toBe(false);
  });
});
