import { describe, it, expect } from "vitest";
import { AgencyGenerator } from "./agencyGenerator.js";
import { parseAgency } from "../parser.js";
import { FunctionDefinition } from "../types.js";

describe("AgencyGenerator - Function Parameter Type Hints", () => {
  describe("processFunctionDefinition", () => {
    const testCases = [
      {
        description: "single parameter with type hint",
        input: "def add(x: number) { x }",
        expectedOutput: "def add(x: number) {\nx\n}",
      },
      {
        description: "multiple parameters with type hints",
        input: "def add(x: number, y: number) { x }",
        expectedOutput: "def add(x: number, y: number) {\nx\n}",
      },
      {
        description: "mixed typed and untyped parameters",
        input: "def mixed(x: number, y) { x }",
        expectedOutput: "def mixed(x: number, y) {\nx\n}",
      },
      {
        description: "array type hint",
        input: "def process(items: number[]) { items }",
        expectedOutput: "def process(items: number[]) {\nitems\n}",
      },
      {
        description: "union type hint",
        input: "def flexible(value: string | number) { value }",
        expectedOutput: "def flexible(value: string | number) {\nvalue\n}",
      },
      {
        description: "type hint with docstring",
        input:
          'def add(x: number, y: number) {\n  """Adds two numbers"""\n  x\n}',
        expectedOutput:
          'def add(x: number, y: number) {\n  """\n  Adds two numbers\n  """\nx\n}',
      },
      {
        description: "multiple array types",
        input: "def multi(arr: string[], count: number) { arr }",
        expectedOutput: "def multi(arr: string[], count: number) {\narr\n}",
      },
      {
        description: "nested array type",
        input: "def nested(matrix: number[][]) { matrix }",
        expectedOutput: "def nested(matrix: number[][]) {\nmatrix\n}",
      },
      {
        description: "custom type name",
        input: "def handle(data: CustomType) { data }",
        expectedOutput: "def handle(data: CustomType) {\ndata\n}",
      },
      {
        description: "untyped parameters (backward compatibility)",
        input: "def old(x, y) { x }",
        expectedOutput: "def old(x, y) {\nx\n}",
      },
    ];

    testCases.forEach(({ description, input, expectedOutput }) => {
      it(`should correctly generate ${description}`, () => {
        const parseResult = parseAgency(input);
        expect(parseResult.success).toBe(true);

        if (!parseResult.success) return;

        const generator = new AgencyGenerator();
        const result = generator.generate(parseResult.result);

        // Normalize whitespace for comparison
        const normalizedOutput = result.output.trim();
        const normalizedExpected = expectedOutput.trim();

        expect(normalizedOutput).toBe(normalizedExpected);
      });
    });
  });

  describe("Type preservation", () => {
    it("should preserve primitive types", () => {
      const input = "def test(n: number, s: string, b: boolean) { n }";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("n: number");
      expect(result.output).toContain("s: string");
      expect(result.output).toContain("b: boolean");
    });

    it("should preserve array types", () => {
      const input = "def test(nums: number[], strs: string[]) { nums }";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("nums: number[]");
      expect(result.output).toContain("strs: string[]");
    });

    it("should preserve union types", () => {
      const input = "def test(val: string | number | boolean) { val }";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("val: string | number | boolean");
    });

    it("should preserve nested array types", () => {
      const input = "def test(matrix: number[][]) { matrix }";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("matrix: number[][]");
    });
  });

  describe("Mixed typed and untyped parameters", () => {
    it("should handle first parameter typed, second untyped", () => {
      const input = "def test(x: number, y) { x }";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("x: number");
      expect(result.output).toContain(", y)");
      expect(result.output).not.toContain("y:");
    });

    it("should handle first parameter untyped, second typed", () => {
      const input = "def test(x, y: string) { x }";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("y: string");
      expect(result.output).toMatch(/test\(x,/);
      expect(result.output).not.toContain("x:");
    });

    it("should handle alternating typed and untyped parameters", () => {
      const input = "def test(a, b: number, c, d: string) { a }";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("b: number");
      expect(result.output).toContain("d: string");
      expect(result.output).not.toContain("a:");
      expect(result.output).not.toContain("c:");
    });
  });
});
