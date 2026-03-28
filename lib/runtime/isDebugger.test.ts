import { describe, it, expect } from "vitest";
import { interrupt, isDebugger, isInterrupt } from "./interrupts.js";

describe("isDebugger", () => {
  it("returns true for an interrupt with debugger: true", () => {
    const i = interrupt("breakpoint");
    i.debugger = true;
    expect(isDebugger(i)).toBe(true);
  });

  it("returns false for a regular interrupt", () => {
    const i = interrupt("regular");
    expect(isDebugger(i)).toBe(false);
  });

  it("returns false for non-interrupt values", () => {
    expect(isDebugger(null)).toBe(false);
    expect(isDebugger(undefined)).toBe(false);
    expect(isDebugger({ type: "other" })).toBe(false);
    expect(isDebugger("string")).toBe(false);
  });

  it("returns false for interrupt with debugger: false", () => {
    const i = interrupt("breakpoint");
    i.debugger = false;
    expect(isDebugger(i)).toBe(false);
  });
});
