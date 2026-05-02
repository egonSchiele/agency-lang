import { describe, it, expect } from "vitest";
import { interrupt, isDebugger, isInterrupt } from "./interrupts.js";

const RUN_ID = "test-run-id";

describe("isDebugger", () => {
  it("returns true for an interrupt with debugger: true", () => {
    const i = interrupt("debug", "breakpoint", {}, "", RUN_ID);
    i.debugger = true;
    expect(isDebugger(i)).toBe(true);
  });

  it("returns false for a regular interrupt", () => {
    const i = interrupt("unknown", "regular", {}, "", RUN_ID);
    expect(isDebugger(i)).toBe(false);
  });

  it("returns false for non-interrupt values", () => {
    expect(isDebugger(null)).toBe(false);
    expect(isDebugger(undefined)).toBe(false);
    expect(isDebugger({ type: "other" })).toBe(false);
    expect(isDebugger("string")).toBe(false);
  });

  it("returns false for interrupt with debugger: false", () => {
    const i = interrupt("debug", "breakpoint", {}, "", RUN_ID);
    i.debugger = false;
    expect(isDebugger(i)).toBe(false);
  });
});
