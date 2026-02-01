import { describe, it, expect } from "vitest";
import { ifParser } from "./function.js";

describe("ifParser", () => {
  const testCases = [
    // Happy path - simple if statements with literals as conditions
    {
      input: "if (true) {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "true" },
          thenBody: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: undefined,
        },
      },
    },
    {
      input: "if (false) {\n  y = 2\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "false" },
          thenBody: [
            {
              type: "assignment",
              variableName: "y",
              value: { type: "number", value: "2" },
            },
          ],
          elseBody: undefined,
        },
      },
    },
    {
      input: "if (x) {\n  foo = 1\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "x" },
          thenBody: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: undefined,
        },
      },
    },
    {
      input: "if (1) {\n  x = 2\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "number", value: "1" },
          thenBody: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "2" },
            },
          ],
          elseBody: undefined,
        },
      },
    },
    {
      input: 'if ("yes") {\n  x = 3\n}',
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "string", value: "yes" },
          thenBody: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "3" },
            },
          ],
          elseBody: undefined,
        },
      },
    },

    // Function calls as conditions
    {
      input: "if (isValid()) {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: {
            type: "functionCall",
            functionName: "isValid",
            arguments: [],
          },
          thenBody: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: undefined,
        },
      },
    },

    // Access expressions as conditions
    {
      input: "if (obj.isReady) {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "obj" },
              propertyName: "isReady",
            },
          },
          thenBody: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: undefined,
        },
      },
    },


    // Index access as conditions
    {
      input: "if (arr[0]) {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: {
            type: "indexAccess",
            object: { type: "variableName", value: "arr" },
            index: { type: "number", value: "0" },
          },
          thenBody: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: undefined,
        },
      },
    },


    // Empty bodies
    {
      input: "if (true) {\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "true" },
          thenBody: [],
          elseBody: undefined,
        },
      },
    },


    // Multiple statements in bodies
    {
      input: "if (x) {\n  a = 1\n  b = 2\n  c = 3\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "x" },
          thenBody: [
            {
              type: "assignment",
              variableName: "a",
              value: { type: "number", value: "1" },
            },
            {
              type: "assignment",
              variableName: "b",
              value: { type: "number", value: "2" },
            },
            {
              type: "assignment",
              variableName: "c",
              value: { type: "number", value: "3" },
            },
          ],
          elseBody: undefined,
        },
      },
    },


    // Whitespace variations
    {
      input: "if(x){\n  foo = 1\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "x" },
          thenBody: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: undefined,
        },
      },
    },
    {
      input: "if  (  x  )  {\n  foo = 1\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "x" },
          thenBody: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: undefined,
        },
      },
    },
    {
      input: "if(x){\nfoo=1\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "x" },
          thenBody: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: undefined,
        },
      },
    },
    {
      input: "if(x){\n  a=1\n}else{\n  b=2\n}",
      expected: {
        success: true,
        result: {
          type: "ifElse",
          condition: { type: "variableName", value: "x" },
          thenBody: [
            {
              type: "assignment",
              variableName: "a",
              value: { type: "number", value: "1" },
            },
          ],
          elseBody: [
            {
              type: "assignment",
              variableName: "b",
              value: { type: "number", value: "2" },
            },
          ],
        },
      },
    },

    // Failure cases - missing parentheses
    {
      input: "if x {\n  foo = 1\n}",
      expected: { success: false },
    },
    {
      input: "if (x {\n  foo = 1\n}",
      expected: { success: false },
    },
    {
      input: "if x) {\n  foo = 1\n}",
      expected: { success: false },
    },

    // Failure cases - missing braces
    {
      input: "if (x) \n  foo = 1\n",
      expected: { success: false },
    },
    {
      input: "if (x) {\n  foo = 1",
      expected: { success: false },
    },
    {
      input: "if (x) \n  foo = 1\n}",
      expected: { success: false },
    },


    // Failure cases - missing condition
    {
      input: "if () {\n  foo = 1\n}",
      expected: { success: false },
    },

    // Failure cases - empty or malformed
    {
      input: "",
      expected: { success: false },
    },
    {
      input: "if",
      expected: { success: false },
    },
    {
      input: "if ()",
      expected: { success: false },
    },
    {
      input: "if (x)",
      expected: { success: false },
    },
    {
      input: "if (x) {}else",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = ifParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = ifParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
