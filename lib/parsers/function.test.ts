import { describe, it, expect } from "vitest";
import {
  functionBodyParser,
  functionParser,
  functionCallParser,
} from "./function";

describe("functionBodyParser", () => {
  const testCases = [
    {
      input: "foo = 1",
      expected: {
        success: true,
        hasBody: true,
      },
    },
    {
      input: 'bar = "hello"',
      expected: {
        success: true,
        hasBody: true,
      },
    },
    {
      input: "x = 5\ny = 10",
      expected: {
        success: true,
        hasBody: true,
      },
    },
    {
      input: "42",
      expected: {
        success: true,
        hasBody: true,
      },
    },
    {
      input: "",
      expected: {
        success: true,
        hasBody: false,
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = functionBodyParser(input);
        expect(result.success).toBe(true);
        if (result.success && expected.hasBody) {
          expect(result.result.length).toBeGreaterThan(0);
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
          expect(result.result.type).toBe(expected.result.type);
          expect(result.result.functionName).toBe(expected.result.functionName);
          expect(result.result.body).toBeDefined();
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

describe("functionCallParser", () => {
  const testCases = [
    {
      input: "test()",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "test",
          arguments: [],
        },
      },
    },
    {
      input: "greet(name)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "greet",
          arguments: ["name"],
        },
      },
    },
    {
      input: "add(x, y)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "add",
          arguments: ["x", "y"],
        },
      },
    },
    {
      input: "process(a, b, c)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "process",
          arguments: ["a", "b", "c"],
        },
      },
    },
    {
      input: "func(arg1,arg2)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "func",
          arguments: ["arg1", "arg2"],
        },
      },
    },
    {
      input: "call( arg )",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "call",
          arguments: ["arg"],
        },
      },
    },
    {
      input: "test",
      expected: { success: false },
    },
    {
      input: "test(",
      expected: { success: false },
    },
    {
      input: "test)",
      expected: { success: false },
    },
    {
      input: "()",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = functionCallParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result.type).toBe(expected.result.type);
          expect(result.result.functionName).toBe(expected.result.functionName);
          expect(result.result.arguments).toEqual(expected.result.arguments);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = functionCallParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
