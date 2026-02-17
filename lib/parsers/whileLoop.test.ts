import { describe, it, expect } from "vitest";
import { whileLoopParser } from "./function.js";

describe("whileLoopParser", () => {
  const testCases = [
    // Happy path - literals as conditions
    {
      input: "while (true) {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "boolean", value: true },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: "while (false) {\n  y = 2\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "boolean", value: false },
          body: [
            {
              type: "assignment",
              variableName: "y",
              value: { type: "number", value: "2" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: "while (x) {\n  foo = 1\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "variableName", value: "x" },
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: "while (1) {\n  x = 2\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "number", value: "1" },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "2" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: 'while ("running") {\n  x = 3\n}',
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "string", segments: [{ type: "text", value: "running" }] },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "3" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Function calls as conditions
    {
      input: "while (hasMore()) {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: {
            type: "functionCall",
            functionName: "hasMore",
            arguments: [],
          },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: "while (isActive(flag)) {\n  process()\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: {
            type: "functionCall",
            functionName: "isActive",
            arguments: [{ type: "variableName", value: "flag" }],
          },
          body: [
            {
              type: "functionCall",
              functionName: "process",
              arguments: [],
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Access expressions as conditions
    {
      input: "while (obj.hasNext) {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "obj" },
              propertyName: "hasNext",
            },
          },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: "while (state.running) {\n  tick()\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "state" },
              propertyName: "running",
            },
          },
          body: [
            {
              type: "functionCall",
              functionName: "tick",
              arguments: [],
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Empty body
    {
      input: "while (true) {\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "boolean", value: true },
          body: [],
        },
      },
    },

    // Multiple statements in body
    {
      input: "while (x) {\n  a = 1\n  b = 2\n  c = 3\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "variableName", value: "x" },
          body: [
            {
              type: "assignment",
              variableName: "a",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
            {
              type: "assignment",
              variableName: "b",
              value: { type: "number", value: "2" },
            },
            {
              type: "newLine",
            },
            {
              type: "assignment",
              variableName: "c",
              value: { type: "number", value: "3" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Whitespace variations
    {
      input: "while(x){\n  foo = 1\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "variableName", value: "x" },
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: "while  (  x  )  {\n  foo = 1\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "variableName", value: "x" },
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Minimal spacing
    {
      input: "while(x){\nfoo=1\n}",
      expected: {
        success: true,
        result: {
          type: "whileLoop",
          condition: { type: "variableName", value: "x" },
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Failure cases - missing parentheses
    {
      input: "while x {\n  foo = 1\n}",
      expected: { success: false },
    },
    {
      input: "while (x {\n  foo = 1\n}",
      expected: { success: false },
    },
    {
      input: "while x) {\n  foo = 1\n}",
      expected: { success: false },
    },

    // Failure cases - missing braces
    {
      input: "while (x) \n  foo = 1\n",
      expected: { success: false },
    },
    {
      input: "while (x) {\n  foo = 1",
      expected: { success: false },
    },
    {
      input: "while (x) \n  foo = 1\n}",
      expected: { success: false },
    },

    // Failure cases - missing condition
    {
      input: "while () {\n  foo = 1\n}",
      expected: { success: false },
    },

    // Failure cases - empty or malformed
    {
      input: "",
      expected: { success: false },
    },
    {
      input: "while",
      expected: { success: false },
    },
    {
      input: "while ()",
      expected: { success: false },
    },
    {
      input: "while (x)",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = whileLoopParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = whileLoopParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
