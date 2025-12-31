import { describe, it, expect } from "vitest";
import { functionBodyParser, functionParser } from "./function";

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
            value: { type: "string", value: "hello" },
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
              type: "prompt",
              segments: [{ type: "text", value: "hello" }],
            },
          },
          { type: "variableName", value: "foo" },
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
        result: [{ type: "number", value: "42" }],
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
        const result = functionBodyParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = functionBodyParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("functionParser", () => {
  const testCases = [
    {
      input: "def test() { foo = 1 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "test",
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    {
      input: "def greet() { bar = `say hello` }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          body: [
            {
              type: "assignment",
              variableName: "bar",
              value: {
                type: "prompt",
                segments: [{ type: "text", value: "say hello" }],
              },
            },
          ],
        },
      },
    },
    {
      input: "def calculate() { x = 5\ny = 10 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "calculate",
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
            {
              type: "assignment",
              variableName: "y",
              value: { type: "number", value: "10" },
            },
          ],
        },
      },
    },
    {
      input: "def empty() {}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "empty",
          body: [],
        },
      },
    },
    {
      input: "def withSpaces() {  foo = 1  }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "withSpaces",
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    {
      input: "def noSpaces(){foo=1}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "noSpaces",
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    {
      input: "def multiline() {\n  x = 5\n  y = 10\n}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "multiline",
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
            {
              type: "assignment",
              variableName: "y",
              value: { type: "number", value: "10" },
            },
          ],
        },
      },
    },
    {
      input: "test() { foo = 1 }",
      expected: { success: false },
    },
    {
      input: "def test { foo = 1 }",
      expected: { success: false },
    },
    {
      input: "def test() foo = 1",
      expected: { success: false },
    },
    {
      input: "def () { foo = 1 }",
      expected: { success: false },
    },
    {
      input: "def test() {",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = functionParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = functionParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});