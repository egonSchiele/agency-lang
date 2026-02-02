import { describe, it, expect } from "vitest";
import { indexAccessParser, accessExpressionParser } from "./access.js";

describe("access expression parsers", () => {
  describe("indexAccessParser", () => {
    const testCases = [
      // Happy path - variable with number index
      {
        input: "arr[0]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "arr" },
            index: { type: "number", value: "0" },
          },
        },
      },
      {
        input: "items[5]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "items" },
            index: { type: "number", value: "5" },
          },
        },
      },
      {
        input: "data[42]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "data" },
            index: { type: "number", value: "42" },
          },
        },
      },

      // Variable as index
      {
        input: "arr[i]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "arr" },
            index: { type: "variableName", value: "i" },
          },
        },
      },
      {
        input: "items[index]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "items" },
            index: { type: "variableName", value: "index" },
          },
        },
      },

      // String as index (for object/map access)
      {
        input: 'obj["key"]',
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "obj" },
            index: {
              type: "string",
              segments: [{ type: "text", value: "key" }],
            },
          },
        },
      },
      {
        input: 'data["field"]',
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "data" },
            index: {
              type: "string",
              segments: [{ type: "text", value: "field" }],
            },
          },
        },
      },

      // Function call as array
      {
        input: "getData()[0]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: {
              type: "functionCall",
              functionName: "getData",
              arguments: [],
            },
            index: { type: "number", value: "0" },
          },
        },
      },
      {
        input: "fetchItems()[5]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: {
              type: "functionCall",
              functionName: "fetchItems",
              arguments: [],
            },
            index: { type: "number", value: "5" },
          },
        },
      },

      // Function call as index
      {
        input: "arr[getIndex()]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "arr" },
            index: {
              type: "functionCall",
              functionName: "getIndex",
              arguments: [],
            },
          },
        },
      },
      {
        input: "items[calculatePosition()]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "items" },
            index: {
              type: "functionCall",
              functionName: "calculatePosition",
              arguments: [],
            },
          },
        },
      },

      // Function call with arguments as array
      {
        input: 'getUsers("active")[0]',
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: {
              type: "functionCall",
              functionName: "getUsers",
              arguments: [
                {
                  type: "string",
                  segments: [{ type: "text", value: "active" }],
                },
              ],
            },
            index: { type: "number", value: "0" },
          },
        },
      },

      // Edge cases - negative index
      {
        input: "arr[-1]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "arr" },
            index: { type: "number", value: "-1" },
          },
        },
      },

      // Edge cases - single character names
      {
        input: "a[0]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "a" },
            index: { type: "number", value: "0" },
          },
        },
      },
      {
        input: "x[i]",
        expected: {
          success: true,
          result: {
            type: "indexAccess",
            array: { type: "variableName", value: "x" },
            index: { type: "variableName", value: "i" },
          },
        },
      },

      // Failure cases
      { input: "arr[]", expected: { success: false } },
      { input: "arr[", expected: { success: false } },
      { input: "arr]", expected: { success: false } },
      { input: "[0]", expected: { success: false } },
      { input: "arr[0", expected: { success: false } },
      { input: "", expected: { success: false } },
      { input: "[]", expected: { success: false } },
      { input: "[", expected: { success: false } },
      { input: "]", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = indexAccessParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = indexAccessParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("accessExpressionParser", () => {
    const testCases = [
      // Dot property access
      {
        input: "obj.foo",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "obj" },
              propertyName: "foo",
            },
          },
        },
      },
      {
        input: "response.status",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "response" },
              propertyName: "status",
            },
          },
        },
      },

      // Dot function call
      {
        input: "story.json()",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: { type: "variableName", value: "story" },
              functionCall: {
                type: "functionCall",
                functionName: "json",
                arguments: [],
              },
            },
          },
        },
      },
      {
        input: "response.text()",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: { type: "variableName", value: "response" },
              functionCall: {
                type: "functionCall",
                functionName: "text",
                arguments: [],
              },
            },
          },
        },
      },
      {
        input: "obj.method(42)",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: { type: "variableName", value: "obj" },
              functionCall: {
                type: "functionCall",
                functionName: "method",
                arguments: [{ type: "number", value: "42" }],
              },
            },
          },
        },
      },

      // Chained function calls
      {
        input: "fetch().json()",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: {
                type: "functionCall",
                functionName: "fetch",
                arguments: [],
              },
              functionCall: {
                type: "functionCall",
                functionName: "json",
                arguments: [],
              },
            },
          },
        },
      },
      {
        input: "getData().process()",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: {
                type: "functionCall",
                functionName: "getData",
                arguments: [],
              },
              functionCall: {
                type: "functionCall",
                functionName: "process",
                arguments: [],
              },
            },
          },
        },
      },
      {
        input: "foo.bar().baz()[3].a1",
        expected: {
          success: true,
          result: {
            expression: {
              object: {
                expression: {
                  array: {
                    expression: {
                      functionCall: {
                        arguments: [],
                        functionName: "baz",
                        type: "functionCall",
                      },
                      object: {
                        expression: {
                          functionCall: {
                            arguments: [],
                            functionName: "bar",
                            type: "functionCall",
                          },
                          object: {
                            type: "variableName",
                            value: "foo",
                          },
                          type: "dotFunctionCall",
                        },
                        type: "accessExpression",
                      },
                      type: "dotFunctionCall",
                    },
                    type: "accessExpression",
                  },
                  index: {
                    type: "number",
                    value: "3",
                  },
                  type: "indexAccess",
                },
                type: "accessExpression",
              },
              propertyName: "a1",
              type: "dotProperty",
            },
            type: "accessExpression",
          },
        },
      },

      // Edge cases
      {
        input: "x.y",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "x" },
              propertyName: "y",
            },
          },
        },
      },
      {
        input: "x.f()",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: { type: "variableName", value: "x" },
              functionCall: {
                type: "functionCall",
                functionName: "f",
                arguments: [],
              },
            },
          },
        },
      },

      // Failure cases
      { input: "", expected: { success: false } },
      { input: "obj", expected: { success: false } }, // just a variable, not an access expression
      { input: "42", expected: { success: false } }, // just a number
      { input: '"string"', expected: { success: false } }, // just a string
      { input: "func()", expected: { success: false } }, // just a function call
      { input: "obj.", expected: { success: false } },
      { input: ".property", expected: { success: false } },
      { input: "[0]", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = accessExpressionParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = accessExpressionParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });
});
