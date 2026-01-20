import { describe, it, expect } from "vitest";
import { functionCallParser } from "./functionCall.js";

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
      input: "processArray([1, 2, 3, 4, 5])",
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
                { type: "number", value: "4" },
                { type: "number", value: "5" },
              ],
            },
          ],
        },
      },
    },
    {
      input: "handleStrings([\"hello\", \"world\"])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "handleStrings",
          arguments: [
            {
              type: "agencyArray",
              items: [
                { type: "string", value: "hello" },
                { type: "string", value: "world" },
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
    {
      input: "processNested([[1, 2], [3, 4]])",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processNested",
          arguments: [
            {
              type: "agencyArray",
              items: [
                {
                  type: "agencyArray",
                  items: [
                    { type: "number", value: "1" },
                    { type: "number", value: "2" },
                  ],
                },
                {
                  type: "agencyArray",
                  items: [
                    { type: "number", value: "3" },
                    { type: "number", value: "4" },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    // Function calls with object arguments
    {
      input: "configure({key: \"value\"})",
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
                  value: { type: "string", value: "value" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "createUser({name: \"Alice\", age: 30})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "createUser",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "name",
                  value: { type: "string", value: "Alice" },
                },
                {
                  key: "age",
                  value: { type: "number", value: "30" },
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
    {
      input: "processData({items: [1, 2, 3]})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "processData",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "items",
                  value: {
                    type: "agencyArray",
                    items: [
                      { type: "number", value: "1" },
                      { type: "number", value: "2" },
                      { type: "number", value: "3" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "nestedConfig({outer: {inner: 42}})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "nestedConfig",
          arguments: [
            {
              type: "agencyObject",
              entries: [
                {
                  key: "outer",
                  value: {
                    type: "agencyObject",
                    entries: [
                      {
                        key: "inner",
                        value: { type: "number", value: "42" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    },
    // Function calls with mixed arguments
    {
      input: "mixed(42, [1, 2], {key: \"value\"})",
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
                  value: { type: "string", value: "value" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "complexCall(\"test\", [], {}, 100)",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "complexCall",
          arguments: [
            { type: "string", value: "test" },
            {
              type: "agencyArray",
              items: [],
            },
            {
              type: "agencyObject",
              entries: [],
            },
            { type: "number", value: "100" },
          ],
        },
      },
    },
    {
      input: "withVariables(x, [y, z], {key: value})",
      expected: {
        success: true,
        result: {
          type: "functionCall",
          functionName: "withVariables",
          arguments: [
            { type: "variableName", value: "x" },
            {
              type: "agencyArray",
              items: [
                { type: "variableName", value: "y" },
                { type: "variableName", value: "z" },
              ],
            },
            {
              type: "agencyObject",
              entries: [
                {
                  key: "key",
                  value: { type: "variableName", value: "value" },
                },
              ],
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
          expect(result.result).toEqual(expected.result);
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
