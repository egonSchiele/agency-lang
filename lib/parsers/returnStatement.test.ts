import { describe, it, expect } from "vitest";
import { returnStatementParser } from "./returnStatement.js";

describe("returnStatementParser", () => {
  const testCases = [
    // Happy path - returning literals
    {
      input: "return 42",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "number", value: "42" },
        },
      },
    },
    {
      input: 'return "hello"',
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "string", segments: [{ type: "text", value: "hello" }] },
        },
      },
    },
    {
      input: "return `say hello`",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: {
            type: "prompt",
            segments: [{ type: "text", value: "say hello" }],
          },
        },
      },
    },
    {
      input: "return myVar",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "variableName", value: "myVar" },
        },
      },
    },

    // With optional semicolon
    {
      input: "return 123;",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "number", value: "123" },
        },
      },
    },

    // With optional spaces
    {
      input: "return  42  ",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "number", value: "42" },
        },
      },
    },
    {
      input: "return 42",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "number", value: "42" },
        },
      },
    },

    // Return function call
    {
      input: "return foo()",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: {
            type: "functionCall",
            functionName: "foo",
            arguments: [],
          },
        },
      },
    },
    {
      input: "return calculate(1, 2)",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: {
            type: "functionCall",
            functionName: "calculate",
            arguments: [
              { type: "number", value: "1" },
              { type: "number", value: "2" },
            ],
          },
        },
      },
    },

    // Return access expression
    {
      input: "return obj.property",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
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

    // Return array
    {
      input: "return [1, 2, 3]",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
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
      input: "return []",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: {
            type: "agencyArray",
            items: [],
          },
        },
      },
    },

    // Return object
    {
      input: 'return { key: "value" }',
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: {
            type: "agencyObject",
            entries: [
              {
                key: "key",
                value: { type: "string", segments: [{ type: "text", value: "value" }] },
              },
            ],
          },
        },
      },
    },
    {
      input: "return {}",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: {
            type: "agencyObject",
            entries: [],
          },
        },
      },
    },
    {
      input: 'return { x: 1, y: 2 }',
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: {
            type: "agencyObject",
            entries: [
              { key: "x", value: { type: "number", value: "1" } },
              { key: "y", value: { type: "number", value: "2" } },
            ],
          },
        },
      },
    },

    // Negative numbers
    {
      input: "return -100",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "number", value: "-100" },
        },
      },
    },

    // Decimal numbers
    {
      input: "return 3.14159",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "number", value: "3.14159" },
        },
      },
    },

    // With semicolon and spaces
    {
      input: "return  someValue  ;",
      expected: {
        success: true,
        result: {
          type: "returnStatement",
          value: { type: "variableName", value: "someValue" },
        },
      },
    },

    // Failure cases
    { input: "return", expected: { success: false } },
    { input: "return;", expected: { success: false } },
    { input: "return ", expected: { success: false } },
    { input: "retur 5", expected: { success: false } },
    { input: "", expected: { success: false } },
    { input: "42", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = returnStatementParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = returnStatementParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
