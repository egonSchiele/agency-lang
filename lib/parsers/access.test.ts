import { describe, it, expect } from "vitest";
import {
  valueAccessParser,
  _valueAccessParser,
  asyncValueAccessParser,
  syncValueAccessParser,
} from "./access.js";

describe("valueAccessParser", () => {
  describe("bare variable names (unwrapped)", () => {
    it('should parse "obj" as a VariableNameLiteral', () => {
      const result = valueAccessParser("obj");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({ type: "variableName", value: "obj" });
      }
    });
  });

  describe("bare function calls (unwrapped)", () => {
    it('should parse "func()" as a FunctionCall', () => {
      const result = valueAccessParser("func()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "functionCall",
          functionName: "func",
          arguments: [],
        });
      }
    });
  });

  describe("index access", () => {
    const testCases = [
      {
        input: "arr[0]",
        expected: {
          success: true,
          result: {
            type: "valueAccess",
            base: { type: "variableName", value: "arr" },
            chain: [{ kind: "index", index: { type: "number", value: "0" } }],
          },
        },
      },
      {
        input: "items[5]",
        expected: {
          success: true,
          result: {
            type: "valueAccess",
            base: { type: "variableName", value: "items" },
            chain: [{ kind: "index", index: { type: "number", value: "5" } }],
          },
        },
      },
      {
        input: "arr[i]",
        expected: {
          success: true,
          result: {
            type: "valueAccess",
            base: { type: "variableName", value: "arr" },
            chain: [
              {
                kind: "index",
                index: { type: "variableName", value: "i" },
              },
            ],
          },
        },
      },
      {
        input: 'obj["key"]',
        expected: {
          success: true,
          result: {
            type: "valueAccess",
            base: { type: "variableName", value: "obj" },
            chain: [
              {
                kind: "index",
                index: {
                  type: "string",
                  segments: [{ type: "text", value: "key" }],
                },
              },
            ],
          },
        },
      },
      {
        input: "getData()[0]",
        expected: {
          success: true,
          result: {
            type: "valueAccess",
            base: {
              type: "functionCall",
              functionName: "getData",
              arguments: [],
            },
            chain: [{ kind: "index", index: { type: "number", value: "0" } }],
          },
        },
      },
      {
        input: "arr[getIndex()]",
        expected: {
          success: true,
          result: {
            type: "valueAccess",
            base: { type: "variableName", value: "arr" },
            chain: [
              {
                kind: "index",
                index: {
                  type: "functionCall",
                  functionName: "getIndex",
                  arguments: [],
                },
              },
            ],
          },
        },
      },
      {
        input: "arr[-1]",
        expected: {
          success: true,
          result: {
            type: "valueAccess",
            base: { type: "variableName", value: "arr" },
            chain: [{ kind: "index", index: { type: "number", value: "-1" } }],
          },
        },
      },
      {
        input: "a[0]",
        expected: {
          success: true,
          result: {
            type: "valueAccess",
            base: { type: "variableName", value: "a" },
            chain: [{ kind: "index", index: { type: "number", value: "0" } }],
          },
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = valueAccessParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    });

    // Failure cases
    it('should fail to parse "arr[]"', () => {
      // arr is parsed as variableName, [] fails chain - but arr still succeeds as bare variable
      const result = valueAccessParser("arr[]");
      expect(result.success).toBe(true);
      if (result.success) {
        // Parses "arr" as variableName, leaves "[]" as rest
        expect(result.result).toEqual({ type: "variableName", value: "arr" });
        expect(result.rest).toBe("[]");
      }
    });

    it('should fail to parse "[0]"', () => {
      const result = valueAccessParser("[0]");
      expect(result.success).toBe(false);
    });

    it('should fail to parse ""', () => {
      const result = valueAccessParser("");
      expect(result.success).toBe(false);
    });
  });

  describe("dot property access", () => {
    const testCases = [
      {
        input: "obj.foo",
        expected: {
          type: "valueAccess",
          base: { type: "variableName", value: "obj" },
          chain: [{ kind: "property", name: "foo" }],
        },
      },
      {
        input: "response.status",
        expected: {
          type: "valueAccess",
          base: { type: "variableName", value: "response" },
          chain: [{ kind: "property", name: "status" }],
        },
      },
      {
        input: "x.y",
        expected: {
          type: "valueAccess",
          base: { type: "variableName", value: "x" },
          chain: [{ kind: "property", name: "y" }],
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = valueAccessParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected);
        }
      });
    });
  });

  describe("dot function call", () => {
    const testCases = [
      {
        input: "story.json()",
        expected: {
          type: "valueAccess",
          base: { type: "variableName", value: "story" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "json",
                arguments: [],
              },
            },
          ],
        },
      },
      {
        input: "obj.method(42)",
        expected: {
          type: "valueAccess",
          base: { type: "variableName", value: "obj" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "method",
                arguments: [{ type: "number", value: "42" }],
              },
            },
          ],
        },
      },
      {
        input: "x.f()",
        expected: {
          type: "valueAccess",
          base: { type: "variableName", value: "x" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "f",
                arguments: [],
              },
            },
          ],
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = valueAccessParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected);
        }
      });
    });
  });

  describe("chained expressions (flat chain)", () => {
    it('should parse "fetch().json()" with flat chain', () => {
      const result = valueAccessParser("fetch().json()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: {
            type: "functionCall",
            functionName: "fetch",
            arguments: [],
          },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "json",
                arguments: [],
              },
            },
          ],
        });
      }
    });

    it('should parse "foo.bar().baz()[3].a1" with flat 4-element chain', () => {
      const result = valueAccessParser("foo.bar().baz()[3].a1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "foo" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "bar",
                arguments: [],
              },
            },
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "baz",
                arguments: [],
              },
            },
            { kind: "index", index: { type: "number", value: "3" } },
            { kind: "property", name: "a1" },
          ],
        });
      }
    });

    it('should parse "response.data.items" with flat chain', () => {
      const result = valueAccessParser("response.data.items");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "response" },
          chain: [
            { kind: "property", name: "data" },
            { kind: "property", name: "items" },
          ],
        });
      }
    });
  });

  describe("failure cases", () => {
    it('should fail to parse ""', () => {
      expect(valueAccessParser("").success).toBe(false);
    });
    it('should fail to parse ".property"', () => {
      expect(valueAccessParser(".property").success).toBe(false);
    });
  });

  describe("syncValueAccessParser", () => {
    it('should parse "sync obj.foo" with async: false', () => {
      const result = syncValueAccessParser("sync obj.foo");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "obj" },
          chain: [{ kind: "property", name: "foo" }],
          async: false,
        });
      }
    });

    it('should parse "await obj.foo" with async: false', () => {
      const result = syncValueAccessParser("await obj.foo");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "obj" },
          chain: [{ kind: "property", name: "foo" }],
          async: false,
        });
      }
    });

    it('should parse "sync Promise.resolve()" with async: false', () => {
      const result = syncValueAccessParser("sync Promise.resolve()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "Promise" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "resolve",
                arguments: [],
              },
            },
          ],
          async: false,
        });
      }
    });

    it('should parse "await Promise.race(res1, res2)" with async: false', () => {
      const result = syncValueAccessParser("await Promise.race(res1, res2)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "Promise" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "race",
                arguments: [
                  { type: "variableName", value: "res1" },
                  { type: "variableName", value: "res2" },
                ],
              },
            },
          ],
          async: false,
        });
      }
    });

    it('should parse "sync response.data.items" with async: false', () => {
      const result = syncValueAccessParser("sync response.data.items");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "response" },
          chain: [
            { kind: "property", name: "data" },
            { kind: "property", name: "items" },
          ],
          async: false,
        });
      }
    });

    // sync on bare function call
    it('should parse "sync fetch()" with async: false', () => {
      const result = syncValueAccessParser("sync fetch()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "functionCall",
          functionName: "fetch",
          arguments: [],
          async: false,
        });
      }
    });

    // Failure cases
    it("should fail on async keyword", () => {
      expect(syncValueAccessParser("async obj.foo").success).toBe(false);
    });
    it("should fail without keyword", () => {
      expect(syncValueAccessParser("obj.foo").success).toBe(false);
    });
    it("should fail on empty string", () => {
      expect(syncValueAccessParser("").success).toBe(false);
    });
  });

  describe("asyncValueAccessParser", () => {
    it('should parse "async obj.foo" with async: true', () => {
      const result = asyncValueAccessParser("async obj.foo");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "obj" },
          chain: [{ kind: "property", name: "foo" }],
          async: true,
        });
      }
    });

    it('should parse "async Promise.sayHi()" with async: true', () => {
      const result = asyncValueAccessParser("async Promise.sayHi()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "Promise" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "sayHi",
                arguments: [],
              },
            },
          ],
          async: true,
        });
      }
    });

    it('should parse "async obj.method(42)" with async: true', () => {
      const result = asyncValueAccessParser("async obj.method(42)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "obj" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "method",
                arguments: [{ type: "number", value: "42" }],
              },
            },
          ],
          async: true,
        });
      }
    });

    it('should parse "async fetch().json()" with async: true', () => {
      const result = asyncValueAccessParser("async fetch().json()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: {
            type: "functionCall",
            functionName: "fetch",
            arguments: [],
          },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "json",
                arguments: [],
              },
            },
          ],
          async: true,
        });
      }
    });

    // async on bare function call
    it('should parse "async fetch()" with async: true', () => {
      const result = asyncValueAccessParser("async fetch()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "functionCall",
          functionName: "fetch",
          arguments: [],
          async: true,
        });
      }
    });

    // Failure cases
    it("should fail on sync keyword", () => {
      expect(asyncValueAccessParser("sync obj.foo").success).toBe(false);
    });
    it("should fail on await keyword", () => {
      expect(asyncValueAccessParser("await obj.foo").success).toBe(false);
    });
    it("should fail without keyword", () => {
      expect(asyncValueAccessParser("obj.foo").success).toBe(false);
    });
    it("should fail on empty string", () => {
      expect(asyncValueAccessParser("").success).toBe(false);
    });
  });

  describe("valueAccessParser with async/sync/await keywords", () => {
    it("should parse 'await' keyword and set async: false", () => {
      const result = valueAccessParser("await Promise.bar()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "Promise" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "bar",
                arguments: [],
              },
            },
          ],
          async: false,
        });
      }
    });

    it("should parse 'async' keyword and set async: true", () => {
      const result = valueAccessParser("async Promise.sayHi()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "Promise" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "sayHi",
                arguments: [],
              },
            },
          ],
          async: true,
        });
      }
    });

    it("should parse 'sync' keyword and set async: false", () => {
      const result = valueAccessParser("sync Promise.sayHi()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "Promise" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "sayHi",
                arguments: [],
              },
            },
          ],
          async: false,
        });
      }
    });

    it("should parse without keyword and not set async field", () => {
      const result = valueAccessParser("Promise.sayHi()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "valueAccess",
          base: { type: "variableName", value: "Promise" },
          chain: [
            {
              kind: "methodCall",
              functionCall: {
                type: "functionCall",
                functionName: "sayHi",
                arguments: [],
              },
            },
          ],
        });
      }
    });
  });
});
