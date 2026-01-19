import { describe, it, expect } from "vitest";
import { assignmentParser } from "./assignment.js";

describe("assignmentParser", () => {
  const testCases = [
    // Happy path - simple literal assignments
    {
      input: "x = 5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          value: { type: "number", value: "5" },
        },
      },
    },
    {
      input: 'name = "Alice"',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "name",
          value: { type: "string", value: "Alice" },
        },
      },
    },
    {
      input: "bar = `the number 1`",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "bar",
          value: {
            type: "prompt",
            segments: [{ type: "text", value: "the number 1" }],
          },
        },
      },
    },
    {
      input: "result = someVariable",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "result",
          value: { type: "variableName", value: "someVariable" },
        },
      },
    },

    // With optional semicolon
    {
      input: "x = 42;",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          value: { type: "number", value: "42" },
        },
      },
    },

    // With optional spaces
    {
      input: "  x  =  5  ",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          value: { type: "number", value: "5" },
        },
      },
    },
    {
      input: "x=5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          value: { type: "number", value: "5" },
        },
      },
    },

    // Variable names with underscores and numbers
    {
      input: "my_var_123 = 999",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "my_var_123",
          value: { type: "number", value: "999" },
        },
      },
    },
    {
      input: "_privateVar = true",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "_privateVar",
          value: { type: "variableName", value: "true" },
        },
      },
    },

    // Function call assignment
    {
      input: "result = foo()",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "result",
          value: {
            type: "functionCall",
            functionName: "foo",
            arguments: [],
          },
        },
      },
    },
    {
      input: 'output = calculate(1, "test")',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "output",
          value: {
            type: "functionCall",
            functionName: "calculate",
            arguments: [
              { type: "number", value: "1" },
              { type: "string", value: "test" },
            ],
          },
        },
      },
    },

    // Array assignment
    {
      input: "arr = [1, 2, 3]",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "arr",
          value: {
            type: "agencyArray",
            items: [
              { type: "number", value: "1" },
              { type: "number", value: "2" },
              { type: "number", value: "3" },
            ],
          },
        },
      },
    },
    {
      input: "empty = []",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "empty",
          value: {
            type: "agencyArray",
            items: [],
          },
        },
      },
    },

    // Object assignment
    {
      input: 'obj = { key: "value" }',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "obj",
          value: {
            type: "agencyObject",
            entries: [
              {
                key: "key",
                value: { type: "string", value: "value" },
              },
            ],
          },
        },
      },
    },
    {
      input: "emptyObj = {}",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "emptyObj",
          value: {
            type: "agencyObject",
            entries: [],
          },
        },
      },
    },

    // Access expression assignment
    {
      input: "value = obj.property",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "value",
          value: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "obj" },
              propertyName: "property",
            },
          },
        },
      },
    },

    // Negative numbers
    {
      input: "negative = -42",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "negative",
          value: { type: "number", value: "-42" },
        },
      },
    },

    // Decimal numbers
    {
      input: "pi = 3.14",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "pi",
          value: { type: "number", value: "3.14" },
        },
      },
    },

    // Failure cases
    { input: "=5", expected: { success: false } },
    { input: "x =", expected: { success: false } },
    { input: "", expected: { success: false } },
    { input: "x", expected: { success: false } },
    { input: "x ==5", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = assignmentParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = assignmentParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
