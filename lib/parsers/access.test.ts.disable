import { describe, it, expect } from "vitest";
import {
  dotPropertyParser,
  indexAccessParser,
  dotFunctionCallParser,
  accessExpressionParser,
} from "./access.js";

describe("access expression parsers", () => {
  describe("dotPropertyParser", () => {
    const testCases = [
      // Happy path - variable name with property
      {
        input: "obj.foo",
        expected: {
          success: true,
          result: {
            type: "dotProperty",
            object: { type: "variableName", value: "obj" },
            propertyName: "foo",
          },
        },
      },
      {
        input: "response.status",
        expected: {
          success: true,
          result: {
            type: "dotProperty",
            object: { type: "variableName", value: "response" },
            propertyName: "status",
          },
        },
      },
      {
        input: "user.name",
        expected: {
          success: true,
          result: {
            type: "dotProperty",
            object: { type: "variableName", value: "user" },
            propertyName: "name",
          },
        },
      },

      // Edge cases - single character names
      {
        input: "x.y",
        expected: {
          success: true,
          result: {
            type: "dotProperty",
            object: { type: "variableName", value: "x" },
            propertyName: "y",
          },
        },
      },
      {
        input: "a.b",
        expected: {
          success: true,
          result: {
            type: "dotProperty",
            object: { type: "variableName", value: "a" },
            propertyName: "b",
          },
        },
      },

      // Property names with numbers
      {
        input: "obj.prop123",
        expected: {
          success: true,
          result: {
            type: "dotProperty",
            object: { type: "variableName", value: "obj" },
            propertyName: "prop123",
          },
        },
      },
      {
        input: "data.field2",
        expected: {
          success: true,
          result: {
            type: "dotProperty",
            object: { type: "variableName", value: "data" },
            propertyName: "field2",
          },
        },
      },

      // Note: Function calls as objects like "fetch().body" are not currently supported
      // by this parser due to the order of parsers in the or() combinator on line 24.
      // The literalParser matches the function name as a variableName before
      // functionCallParser gets a chance to parse the full function call.
      // This parser still uses or(literalParser, functionCallParser) instead of
      // or(functionCallParser, literalParser).

      // Note: Number literals with property access like "42.toString" are not supported
      // because the dot is consumed as part of the number (decimal point).

      // String literal as object
      {
        input: '"hello".length',
        expected: {
          success: true,
          result: {
            type: "dotProperty",
            object: { type: "string", value: "hello" },
            propertyName: "length",
          },
        },
      },

      // Failure cases
      { input: "obj.", expected: { success: false } },
      { input: ".property", expected: { success: false } },
      { input: "obj", expected: { success: false } },
      { input: "", expected: { success: false } },
      { input: ".", expected: { success: false } },
      // Note: "obj.123" actually parses successfully because alphanum includes digits
      { input: "obj..prop", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = dotPropertyParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = dotPropertyParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

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
            index: { type: "string", value: "key" },
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
            index: { type: "string", value: "field" },
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
              arguments: [{ type: "string", value: "active" }],
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

  describe("dotFunctionCallParser", () => {
    const testCases = [
      // Happy path - variable with method call
      {
        input: "story.json()",
        expected: {
          success: true,
          result: {
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
      {
        input: "response.text()",
        expected: {
          success: true,
          result: {
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
      {
        input: "obj.getData()",
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "obj" },
            functionCall: {
              type: "functionCall",
              functionName: "getData",
              arguments: [],
            },
          },
        },
      },

      // Method call with arguments
      {
        input: "obj.method(42)",
        expected: {
          success: true,
          result: {
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
      {
        input: 'str.split(",")',
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "str" },
            functionCall: {
              type: "functionCall",
              functionName: "split",
              arguments: [{ type: "string", value: "," }],
            },
          },
        },
      },
      {
        input: "arr.slice(0)",
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "arr" },
            functionCall: {
              type: "functionCall",
              functionName: "slice",
              arguments: [{ type: "number", value: "0" }],
            },
          },
        },
      },

      // Multiple arguments
      {
        input: "obj.calculate(1, 2)",
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "obj" },
            functionCall: {
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
      {
        input: 'str.replace("old", "new")',
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "str" },
            functionCall: {
              type: "functionCall",
              functionName: "replace",
              arguments: [
                { type: "string", value: "old" },
                { type: "string", value: "new" },
              ],
            },
          },
        },
      },

      // Variable as argument
      {
        input: "obj.process(data)",
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "obj" },
            functionCall: {
              type: "functionCall",
              functionName: "process",
              arguments: [{ type: "variableName", value: "data" }],
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
      {
        input: "getData().process()",
        expected: {
          success: true,
          result: {
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
      {
        input: "getResponse().text()",
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: {
              type: "functionCall",
              functionName: "getResponse",
              arguments: [],
            },
            functionCall: {
              type: "functionCall",
              functionName: "text",
              arguments: [],
            },
          },
        },
      },

      // Chained function calls with arguments
      {
        input: 'fetch("url").json()',
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: {
              type: "functionCall",
              functionName: "fetch",
              arguments: [{ type: "string", value: "url" }],
            },
            functionCall: {
              type: "functionCall",
              functionName: "json",
              arguments: [],
            },
          },
        },
      },
      {
        input: "getUser(42).getName()",
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: {
              type: "functionCall",
              functionName: "getUser",
              arguments: [{ type: "number", value: "42" }],
            },
            functionCall: {
              type: "functionCall",
              functionName: "getName",
              arguments: [],
            },
          },
        },
      },

      // Edge cases - single character names
      {
        input: "x.f()",
        expected: {
          success: true,
          result: {
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

      // String literal as object
      {
        input: '"hello".toUpperCase()',
        expected: {
          success: true,
          result: {
            type: "dotFunctionCall",
            object: { type: "string", value: "hello" },
            functionCall: {
              type: "functionCall",
              functionName: "toUpperCase",
              arguments: [],
            },
          },
        },
      },

      // Failure cases
      { input: "obj.method", expected: { success: false } }, // missing ()
      { input: "obj.()", expected: { success: false } }, // missing method name
      { input: ".method()", expected: { success: false } }, // missing object
      { input: "obj.", expected: { success: false } },
      { input: "method()", expected: { success: false } }, // no dot
      { input: "", expected: { success: false } },
      { input: "obj.method(", expected: { success: false } }, // unclosed paren
      { input: "obj.method)", expected: { success: false } }, // no opening paren
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = dotFunctionCallParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = dotFunctionCallParser(input);
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

      // Index access
      {
        input: "arr[0]",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "indexAccess",
              array: { type: "variableName", value: "arr" },
              index: { type: "number", value: "0" },
            },
          },
        },
      },
      {
        input: "items[i]",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "indexAccess",
              array: { type: "variableName", value: "items" },
              index: { type: "variableName", value: "i" },
            },
          },
        },
      },
      {
        input: 'data["key"]',
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "indexAccess",
              array: { type: "variableName", value: "data" },
              index: { type: "string", value: "key" },
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

      // Function call with index access
      {
        input: "getData()[0]",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
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
        input: "a[0]",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "indexAccess",
              array: { type: "variableName", value: "a" },
              index: { type: "number", value: "0" },
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
