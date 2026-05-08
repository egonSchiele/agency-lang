import { describe, expect, it } from "vitest";
import { modifiedAssignmentParser } from "./parsers.js";

describe("export const", () => {
  it("parses export const", () => {
    const result = modifiedAssignmentParser(`export const x = 5\n`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.declKind).toBe("const");
      expect(result.result.variableName).toBe("x");
    }
  });

  it("parses export static const", () => {
    const result = modifiedAssignmentParser(`export static const x = 5\n`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.static).toBe(true);
      expect(result.result.declKind).toBe("const");
    }
  });

  it("parses static export const (any order)", () => {
    const result = modifiedAssignmentParser(`static export const x = 5\n`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.static).toBe(true);
      expect(result.result.declKind).toBe("const");
    }
  });

  // The parser accepts export let syntactically; the typechecker is responsible
  // for rejecting it (export only makes sense for const declarations).
  it("parses export let (typechecker rejects this, not parser)", () => {
    const result = modifiedAssignmentParser(`export let x = 5\n`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.declKind).toBe("let");
    }
  });
});
