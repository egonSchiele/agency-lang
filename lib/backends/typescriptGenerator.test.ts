import { describe, it, expect } from "vitest";
import { TypeScriptGenerator } from "./typescriptGenerator.js";
import { parseAgency } from "../parser.js";

describe("TypeScriptGenerator - Smart parenthesization", () => {
  function compileTS(input: string): string {
    const parseResult = parseAgency(input);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return "";
    const generator = new TypeScriptGenerator({ config: {} });
    return generator.generate(parseResult.result).output;
  }

  describe("no unnecessary parens", () => {
    it("should not add parens for chained addition", () => {
      const output = compileTS("x = 1 + 2 + 3 + 4");
      expect(output).toContain("1 + 2 + 3 + 4");
    });

    it("should not add parens when right child has higher precedence", () => {
      const output = compileTS("x = 1 + 2 * 3");
      expect(output).toContain("1 + 2 * 3");
    });

    it("should not add parens when left child has higher precedence", () => {
      const output = compileTS("x = 2 * 3 + 1");
      expect(output).toContain("2 * 3 + 1");
    });

    it("should not add parens for chained string concat", () => {
      const output = compileTS('x = "a" + "b" + "c"');
      expect(output).toContain('`a` + `b` + `c`');
    });
  });

  describe("parens preserved when needed", () => {
    it("should preserve parens when left child has lower precedence", () => {
      const output = compileTS("x = (1 + 2) * 3");
      expect(output).toContain("(1 + 2) * 3");
    });

    it("should preserve parens when right child has same precedence", () => {
      const output = compileTS("x = 1 - (2 + 3)");
      expect(output).toContain("1 - (2 + 3)");
    });

    it("should preserve parens for right-nested subtraction", () => {
      const output = compileTS("x = 1 - (2 - 3)");
      expect(output).toContain("1 - (2 - 3)");
    });

    it("should preserve parens for right-nested division", () => {
      const output = compileTS("x = 8 / (4 / 2)");
      expect(output).toContain("8 / (4 / 2)");
    });
  });
});
