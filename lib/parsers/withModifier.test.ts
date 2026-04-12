import { describe, it, expect } from "vitest";
import { withModifierParser } from "./function.js";
import { normalizeCode } from "@/index.js";

describe("withModifierParser", () => {
  it("should parse const assignment with approve", () => {
    const input = 'const text = read("file.txt") with approve';
    const result = withModifierParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("withModifier");
      expect(result.result.handlerName).toBe("approve");
      expect(result.result.statement.type).toBe("assignment");
    }
  });

  it("should parse assignment with reject", () => {
    const input = 'const text = read("file.txt") with reject';
    const result = withModifierParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.handlerName).toBe("reject");
    }
  });

  it("should parse assignment with propagate", () => {
    const input = 'const text = read("file.txt") with propagate';
    const result = withModifierParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.handlerName).toBe("propagate");
    }
  });

  it("should parse let assignment with approve", () => {
    const input = 'let text = read("file.txt") with approve';
    const result = withModifierParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.statement.type).toBe("assignment");
    }
  });

  it("should parse bare function call with approve", () => {
    const input = "doSomething() with approve";
    const result = withModifierParser(normalizeCode(input));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("withModifier");
      expect(result.result.handlerName).toBe("approve");
    }
  });

  it("should fail without handler name", () => {
    const input = 'const text = read("file.txt") with';
    const result = withModifierParser(normalizeCode(input));
    expect(result.success).toBe(false);
  });

  it("should fail with non-builtin handler name", () => {
    const input = 'const text = read("file.txt") with myHandler';
    const result = withModifierParser(normalizeCode(input));
    expect(result.success).toBe(false);
  });

  it("should not interfere with regular assignments", () => {
    const input = 'const text = read("file.txt")';
    const result = withModifierParser(normalizeCode(input));
    expect(result.success).toBe(false);
  });
});
