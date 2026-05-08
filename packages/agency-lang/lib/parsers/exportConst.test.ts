import { describe, expect, it } from "vitest";
import { assignmentParser } from "./parsers.js";

describe("export const", () => {
  it("parses export const", () => {
    const result = assignmentParser(`export const x = 5\n`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.declKind).toBe("const");
      expect(result.result.variableName).toBe("x");
    }
  });

  it("does not allow export let", () => {
    expect(() => assignmentParser(`export let x = 5\n`)).toThrow(
      "Only const declarations can be exported",
    );
  });

  it("parses const without export", () => {
    const result = assignmentParser(`const x = 5\n`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBeUndefined();
    }
  });
});
