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
  it("parses export destructive def", () => {
    const result = functionParser(`export destructive def foo() {\n  return 1\n}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.markers?.destructive).toBe(true);
    }
  });

  it("parses destructive export def (any order)", () => {
    const result = functionParser(`destructive export def foo() {\n  return 1\n}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.exported).toBe(true);
      expect(result.result.markers?.destructive).toBe(true);
    }
  });
});
