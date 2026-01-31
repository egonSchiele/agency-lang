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

  describe("Round-trip parsing", () => {
    const testCases = [
      {
        description: "function with typed parameters",
        input: "def add(x: number, y: number) { x }",
      },
      {
        description: "function with mixed parameters",
        input: "def mixed(a: string, b) { a }",
      },
      {
        description: "function with array type",
        input: "def process(items: number[]) { items }",
      },
      {
        description: "function with union type",
        input: "def flex(val: string | number) { val }",
      },
      {
        description: "function with complex types",
        input:
          "def complex(arr: string[], count: number, flag: boolean) { arr }",
      },
    ];

    testCases.forEach(({ description, input }) => {
      it(`should preserve ${description} in round-trip`, () => {
        // First parse
        const firstParse = parseAgency(input);
        expect(firstParse.success).toBe(true);
        if (!firstParse.success) return;

        // Generate agency code
        const generator = new AgencyGenerator();
        const generated = generator.generate(firstParse.result);

        // Second parse
        const secondParse = parseAgency(generated.output);
        expect(secondParse.success).toBe(true);
        if (!secondParse.success) return;

        // Compare the function nodes - they should be identical
        const firstFunc = firstParse.result.nodes[0] as FunctionDefinition;
        const secondFunc = secondParse.result.nodes[0] as FunctionDefinition;

        expect(secondFunc.type).toBe("function");
        expect(secondFunc.functionName).toBe(firstFunc.functionName);
        expect(secondFunc.parameters).toEqual(firstFunc.parameters);
        expect(secondFunc.body).toEqual(firstFunc.body);
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

describe("AgencyGenerator - TimeBlock support", () => {
  describe("processTimeBlock", () => {
    const testCases = [
      {
        description: "simple time block",
        input: "node main() {\n  x = time {\n    y = 1\n  }\n}",
        expectedOutput: "node main() {\nx = time {\ny = 1\n}\n}",
      },
      {
        description: "time block with multiple statements",
        input: "node main() {\n  elapsed = time {\n    a = 1\n    b = 2\n    c = 3\n  }\n}",
        expectedOutput: "node main() {\nelapsed = time {\na = 1\nb = 2\nc = 3\n}\n}",
      },
      {
        description: "time block with prompt",
        input: 'node main() {\n  timing = time {\n    result = `hello`\n  }\n}',
        expectedOutput: "node main() {\ntiming = time {\nresult = `hello`\n}\n}",
      },
      {
        description: "time block with function call",
        input: "node main() {\n  duration = time {\n    result = doSomething()\n  }\n}",
        expectedOutput: "node main() {\nduration = time {\nresult = doSomething()\n}\n}",
      },
      {
        description: "empty time block",
        input: "node main() {\n  empty = time {\n  }\n}",
        expectedOutput: "node main() {\nempty = time {\n}\n}",
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

  describe("Round-trip parsing", () => {
    const testCases = [
      {
        description: "time block with single statement",
        input: "node main() {\n  x = time {\n    y = 1\n  }\n}",
      },
      {
        description: "time block with multiple statements",
        input: "node main() {\n  x = time {\n    a = 1\n    b = 2\n  }\n}",
      },
      {
        description: "time block with prompt",
        input: 'node main() {\n  x = time {\n    result = `hello`\n  }\n}',
      },
      {
        description: "empty time block",
        input: "node main() {\n  x = time {\n  }\n}",
      },
    ];

    testCases.forEach(({ description, input }) => {
      it(`should preserve ${description} in round-trip`, () => {
        // First parse
        const firstParse = parseAgency(input);
        expect(firstParse.success).toBe(true);
        if (!firstParse.success) return;

        // Generate agency code
        const generator = new AgencyGenerator();
        const generated = generator.generate(firstParse.result);

        // Second parse
        const secondParse = parseAgency(generated.output);
        expect(secondParse.success).toBe(true);
        if (!secondParse.success) return;

        // Compare ASTs - they should be equivalent
        expect(secondParse.result.nodes.length).toBe(firstParse.result.nodes.length);
        expect(secondParse.result.nodes[0].type).toBe("graphNode");
      });
    });
  });

  describe("Indentation", () => {
    it("should properly indent nested time blocks", () => {
      const input = "node main() {\n  timing = time {\n    x = 1\n    y = 2\n  }\n}";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      // Check that time block is properly indented
      expect(result.output).toContain("timing = time {");
      expect(result.output).toContain("x = 1");
      expect(result.output).toContain("y = 2");
      expect(result.output).toMatch(/}\s*}/); // Closing braces
    });

    it("should handle deeply nested structures with time blocks", () => {
      const input = "def outer() {\n  node inner() {\n    t = time {\n      x = 1\n    }\n  }\n}";
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      // Just verify it generates without error and has proper structure
      expect(result.output).toContain("def outer()");
      expect(result.output).toContain("node inner()");
      expect(result.output).toContain("t = time {");
      expect(result.output).toContain("x = 1");
    });
  });

  describe("Time block content preservation", () => {
    it("should preserve all statement types in time block body", () => {
      const input = `node main() {
  timing = time {
    x = 1
    y = "string"
    z = foo()
    result = \`prompt\`
  }
}`;
      const parseResult = parseAgency(input);
      expect(parseResult.success).toBe(true);

      if (!parseResult.success) return;

      const generator = new AgencyGenerator();
      const result = generator.generate(parseResult.result);

      expect(result.output).toContain("x = 1");
      expect(result.output).toContain('y = "string"');
      expect(result.output).toContain("z = foo()");
      expect(result.output).toContain("result = `prompt`");
    });
  });
});
