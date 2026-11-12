import { describe, it, expect } from "vitest";
import { collapseCarriageReturns } from "./progressText.js";

describe("collapseCarriageReturns", () => {
  it("keeps the last state of a progress bar", () => {
    expect(collapseCarriageReturns("10%\r50%\r100%\n")).toBe("100%\n");
  });

  it("treats \\r\\n as a line ending", () => {
    expect(collapseCarriageReturns("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("leaves text with no carriage return unchanged", () => {
    expect(collapseCarriageReturns("one\ntwo\n")).toBe("one\ntwo\n");
  });

  it("keeps the text before a trailing carriage return", () => {
    expect(collapseCarriageReturns("10%\r")).toBe("10%");
  });
});
