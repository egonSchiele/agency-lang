import { describe, expect, it } from "vitest";
import { bodyParser } from "./parsers.js";

describe("functionBodyParser", () => {
  const testCases = [
    {
      input: "foo = 1",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "foo",
            value: { type: "number", value: "1" },
          },
        ],
      },
    },
    {
      input: 'bar = "hello"',
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "bar",
            value: {
              type: "string",
              segments: [{ type: "text", value: "hello" }],
            },
          },
        ],
      },
    },
    {
      input: "bar = `hello`\nfoo",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "bar",
            value: {
              type: "string",
              segments: [{ type: "text", value: "hello" }],
            },
          },
          {
            type: "newLine",
          },
          {
            type: "variableName",
            value: "foo",
          },
        ],
      },
    },
    {
      input: "x = 5\ny = 10",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "5" },
          },
          {
            type: "newLine",
          },
          {
            type: "assignment",
            variableName: "y",
            value: { type: "number", value: "10" },
          },
        ],
      },
    },
    {
      input: "42",
      expected: {
        success: true,
        result: [
          {
            type: "number",
            value: "42",
          },
        ],
      },
    },
    {
      input: "",
      expected: {
        success: true,
        result: [],
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = bodyParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = bodyParser(input);
        expect(result.success).toBe(false);
      });
    }
  });

  it("parses a nested def inside a function body", () => {
    const input = `def inner(x: number): number {\n  return x + 1\n}`;
    const result = bodyParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.length).toBe(1);
      expect(result.result[0].type).toBe("function");
      expect((result.result[0] as any).functionName).toBe("inner");
    }
  });

  it("parses multiple nested defs", () => {
    const input = `def a(): number {\n  return 1\n}\ndef b(): number {\n  return 2\n}`;
    const result = bodyParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const fns = result.result.filter((n: any) => n.type === "function");
      expect(fns.length).toBe(2);
      expect((fns[0] as any).functionName).toBe("a");
      expect((fns[1] as any).functionName).toBe("b");
    }
  });

  it("parses safe def inside a function body", () => {
    const input = `safe def helper(x: number): number {\n  return x + 1\n}`;
    const result = bodyParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.length).toBe(1);
      expect(result.result[0].type).toBe("function");
      expect((result.result[0] as any).safe).toBe(true);
    }
  });
});
