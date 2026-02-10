import { describe, it, expect } from "vitest";
import {
  indexAccessParser,
  accessExpressionParser,
  syncAccessExpressionParser,
  asyncAccessExpressionParser,
} from "./access.js";

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

  describe("syncAccessExpressionParser", () => {
    const testCases = [
      // sync keyword - dot property
      {
        input: "sync obj.foo",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "obj" },
              propertyName: "foo",
            },
            async: false,
          },
        },
      },

      // await keyword - dot property
      {
        input: "await obj.foo",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "obj" },
              propertyName: "foo",
            },
            async: false,
          },
        },
      },

      // sync keyword - dot function call
      {
        input: "sync Promise.resolve()",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: { type: "variableName", value: "Promise" },
              functionCall: {
                type: "functionCall",
                functionName: "resolve",
                arguments: [],
              },
            },
            async: false,
          },
        },
      },

      // await keyword - dot function call
      {
        input: "await Promise.bar()",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: { type: "variableName", value: "Promise" },
              functionCall: {
                type: "functionCall",
                functionName: "bar",
                arguments: [],
              },
            },
            async: false,
          },
        },
      },

      // await keyword - dot function call with arguments
      {
        input: "await Promise.race(res1, res2)",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: { type: "variableName", value: "Promise" },
              functionCall: {
                type: "functionCall",
                functionName: "race",
                arguments: [
                  { type: "variableName", value: "res1" },
                  { type: "variableName", value: "res2" },
                ],
              },
            },
            async: false,
          },
        },
      },

      // sync keyword - chained access
      {
        input: "sync response.data.items",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: {
                type: "accessExpression",
                expression: {
                  type: "dotProperty",
                  object: { type: "variableName", value: "response" },
                  propertyName: "data",
                },
              },
              propertyName: "items",
            },
            async: false,
          },
        },
      },

      // Failure cases
      { input: "async obj.foo", expected: { success: false } },
      { input: "obj.foo", expected: { success: false } },
      { input: "syncobj.foo", expected: { success: false } },
      { input: "awaitobj.foo", expected: { success: false } },
      { input: "sync", expected: { success: false } },
      { input: "await", expected: { success: false } },
      { input: "sync ", expected: { success: false } },
      { input: "await ", expected: { success: false } },
      { input: "", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = syncAccessExpressionParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = syncAccessExpressionParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("asyncAccessExpressionParser", () => {
    const testCases = [
      // async keyword - dot property
      {
        input: "async obj.foo",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotProperty",
              object: { type: "variableName", value: "obj" },
              propertyName: "foo",
            },
            async: true,
          },
        },
      },

      // async keyword - dot function call
      {
        input: "async Promise.sayHi()",
        expected: {
          success: true,
          result: {
            type: "accessExpression",
            expression: {
              type: "dotFunctionCall",
              object: { type: "variableName", value: "Promise" },
              functionCall: {
                type: "functionCall",
                functionName: "sayHi",
                arguments: [],
              },
            },
            async: true,
          },
        },
      },

      // async keyword - dot function call with arguments
      {
        input: "async obj.method(42)",
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
            async: true,
          },
        },
      },

      // async keyword - chained access
      {
        input: "async fetch().json()",
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
            async: true,
          },
        },
      },

      // Failure cases
      { input: "sync obj.foo", expected: { success: false } },
      { input: "await obj.foo", expected: { success: false } },
      { input: "obj.foo", expected: { success: false } },
      { input: "asyncobj.foo", expected: { success: false } },
      { input: "async", expected: { success: false } },
      { input: "async ", expected: { success: false } },
      { input: "", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = asyncAccessExpressionParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = asyncAccessExpressionParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("accessExpressionParser with async/sync/await keywords", () => {
    it("should parse 'await' keyword and set async: false", () => {
      const result = accessExpressionParser("await Promise.bar()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "accessExpression",
          expression: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "Promise" },
            functionCall: {
              type: "functionCall",
              functionName: "bar",
              arguments: [],
            },
          },
          async: false,
        });
      }
    });

    it("should parse 'async' keyword and set async: true", () => {
      const result = accessExpressionParser("async Promise.sayHi()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "accessExpression",
          expression: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "Promise" },
            functionCall: {
              type: "functionCall",
              functionName: "sayHi",
              arguments: [],
            },
          },
          async: true,
        });
      }
    });

    it("should parse 'sync' keyword and set async: false", () => {
      const result = accessExpressionParser("sync Promise.sayHi()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "accessExpression",
          expression: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "Promise" },
            functionCall: {
              type: "functionCall",
              functionName: "sayHi",
              arguments: [],
            },
          },
          async: false,
        });
      }
    });

    it("should parse without keyword and not set async field", () => {
      const result = accessExpressionParser("Promise.sayHi()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "accessExpression",
          expression: {
            type: "dotFunctionCall",
            object: { type: "variableName", value: "Promise" },
            functionCall: {
              type: "functionCall",
              functionName: "sayHi",
              arguments: [],
            },
          },
        });
      }
    });
  });
});
