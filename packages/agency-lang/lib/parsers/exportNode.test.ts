import { describe, expect, it } from "vitest";
import { graphNodeParser, functionParser } from "./parsers.js";

describe("export node", () => {
  it("parses export node", () => {
    const result = graphNodeParser(`export node main() {\n  print("hello")\n}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.nodeName).toBe("main");
    }
  });

  it("parses node without export", () => {
    const result = graphNodeParser(`node main() {\n  print("hello")\n}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBeUndefined();
    }
  });
});

describe("function modifier order", () => {
  it("parses export safe def", () => {
    const result = functionParser(`export safe def foo() {\n  return 1\n}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.safe).toBe(true);
    }
  });

  it("parses safe export def (any order)", () => {
    const result = functionParser(`safe export def foo() {\n  return 1\n}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.safe).toBe(true);
    }
  });
});
