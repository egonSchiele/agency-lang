import { describe, it, expect } from "vitest";
import {
  functionCallParser,
} from "./functionCall.js";
import {
  valueAccessParser,
  asyncValueAccessParser,
  syncValueAccessParser,
} from "./access.js";

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
          arguments: [{ type: "variableName", value: "name" }],
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
          arguments: [
            { type: "variableName", value: "x" },
            { type: "variableName", value: "y" },
          ],
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
          arguments: [
            { type: "variableName", value: "a" },
            { type: "variableName", value: "b" },
            { type: "variableName", value: "c" },
          ],
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
          arguments: [
            { type: "variableName", value: "arg1" },
            { type: "variableName", value: "arg2" },
          ],
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
          arguments: [{ type: "variableName", value: "arg" }],
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
    // Function calls with array arguments
    {
      input: "processArray([1, 2, 3])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processArray",
          arguments: [
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
                { type: "number", value: "3" },
              ],
            },
          ],
        },
      },
    },
    {
      input: "processEmpty([])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processEmpty",
          arguments: [
            {
              type: "agencyArray",
              items: [],
            },
          ],
        },
      },
    },
    // Function calls with object arguments
    {
      input: 'configure({key: "value"})',
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "configure",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: { type: "string", segments: [{ type: "text", value: "value" }] },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "initialize({})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "initialize",
          arguments: [
            {
              type: "agencyObject",
              entries: [],
            },
          ],
        },
      },
    },
    // Function calls with binop arguments
    {
      input: "add(x * 2, y + 1)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "add",
          arguments: [
            {
              type: "binOpExpression",
              operator: "*",
              left: { type: "variableName", value: "x" },
              right: { type: "number", value: "2" },
            },
            {
              type: "binOpExpression",
              operator: "+",
              left: { type: "variableName", value: "y" },
              right: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    {
      input: "check(a == b)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "check",
          arguments: [
            {
              type: "binOpExpression",
              operator: "==",
              left: { type: "variableName", value: "a" },
              right: { type: "variableName", value: "b" },
            },
          ],
        },
      },
    },
    {
      input: "test(a && b || c)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "test",
          arguments: [
            {
              type: "binOpExpression",
              operator: "||",
              left: {
                type: "binOpExpression",
                operator: "&&",
                left: { type: "variableName", value: "a" },
                right: { type: "variableName", value: "b" },
              },
              right: { type: "variableName", value: "c" },
            },
          ],
        },
      },
    },
    // Function calls with mixed arguments
    {
      input: 'mixed(42, [1, 2], {key: "value"})',
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "mixed",
          arguments: [
            { type: "number", value: "42" },
            {
              type: "agencyArray",
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
              ],
            },
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: { type: "string", segments: [{ type: "text", value: "value" }] },
                },
              ],
            },
          ],
        },
      },
    },
    // Spread argument in function call
    {
      input: "print(...args)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "print",
          arguments: [
            {
              type: "splat",
              value: { type: "variableName", value: "args" },
            },
          ],
        },
      },
    },
    // Mixed regular and spread arguments
    {
      input: 'log("hello", ...rest)',
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "log",
          arguments: [
            { type: "string", segments: [{ type: "text", value: "hello" }] },
            {
              type: "splat",
              value: { type: "variableName", value: "rest" },
            },
          ],
        },
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = functionCallParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
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

describe("async/sync function calls via valueAccessParser", () => {
  it("should parse 'async bar()' with async: true", () => {
    const result = valueAccessParser("async bar()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "functionCall",
        functionName: "bar",
        arguments: [],
        async: true,
      });
    }
  });

  it("should parse 'sync bar()' with async: false", () => {
    const result = valueAccessParser("sync bar()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "functionCall",
        functionName: "bar",
        arguments: [],
        async: false,
      });
    }
  });

  it("should parse 'await bar()' with async: false", () => {
    const result = valueAccessParser("await bar()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "functionCall",
        functionName: "bar",
        arguments: [],
        async: false,
      });
    }
  });

  it("should parse without keyword and not set async field", () => {
    const result = valueAccessParser("bar()");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "functionCall",
        functionName: "bar",
        arguments: [],
      });
    }
  });

  it("should parse 'await' with arguments", () => {
    const result = valueAccessParser("await sayHi(name, age)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "functionCall",
        functionName: "sayHi",
        arguments: [
          { type: "variableName", value: "name" },
          { type: "variableName", value: "age" },
        ],
        async: false,
      });
    }
  });

  it("should parse 'async' with arguments", () => {
    const result = valueAccessParser("async sayHi(name)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "functionCall",
        functionName: "sayHi",
        arguments: [{ type: "variableName", value: "name" }],
        async: true,
      });
    }
  });
});

describe("arbitrary expressions as arguments", () => {
  it("should allow binary operation as argument", () => {
    const result = functionCallParser("foo(a + b)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.arguments.length).toBe(1);
      expect(result.result.arguments[0].type).toBe("binOpExpression");
    }
  });

  it("should allow nested function call as argument", () => {
    const result = functionCallParser("foo(bar(baz()))");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.arguments.length).toBe(1);
      expect(result.result.arguments[0].type).toBe("functionCall");
    }
  });

  it("should allow parenthesized expression as argument", () => {
    const result = functionCallParser("foo((a + b) * c)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.arguments.length).toBe(1);
      expect(result.result.arguments[0].type).toBe("binOpExpression");
    }
  });

  it("should allow multiple expression arguments", () => {
    const result = functionCallParser("foo(a + b, c * d)");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.arguments.length).toBe(2);
      expect(result.result.arguments[0].type).toBe("binOpExpression");
      expect(result.result.arguments[1].type).toBe("binOpExpression");
    }
  });
});

// TODO: streamingPromptLiteralParser tests removed — streaming now handled via config object.
// Streaming will be passed as { stream: true } in the llm() config argument.
