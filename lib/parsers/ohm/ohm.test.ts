import { describe, it, expect } from "vitest";
import { parseWithOhm } from "./index.js";

describe("Ohm parser", () => {
  describe("Number literals", () => {
    it("parses integers", () => {
      expect(parseWithOhm("42")).toEqual({ type: "number", value: "42" });
    });

    it("parses floats", () => {
      expect(parseWithOhm("3.14")).toEqual({ type: "number", value: "3.14" });
    });

    it("parses negative numbers", () => {
      expect(parseWithOhm("-5")).toEqual({ type: "number", value: "-5" });
    });

    it("parses negative floats", () => {
      expect(parseWithOhm("-2.5")).toEqual({ type: "number", value: "-2.5" });
    });

    it("parses zero", () => {
      expect(parseWithOhm("0")).toEqual({ type: "number", value: "0" });
    });
  });

  describe("Boolean literals", () => {
    it("parses true", () => {
      expect(parseWithOhm("true")).toEqual({ type: "boolean", value: true });
    });

    it("parses false", () => {
      expect(parseWithOhm("false")).toEqual({ type: "boolean", value: false });
    });
  });

  describe("Variable name literals", () => {
    it("parses simple names", () => {
      expect(parseWithOhm("foo")).toEqual({ type: "variableName", value: "foo" });
    });

    it("parses names with underscores", () => {
      expect(parseWithOhm("my_var")).toEqual({ type: "variableName", value: "my_var" });
    });

    it("parses names starting with underscore", () => {
      expect(parseWithOhm("_private")).toEqual({ type: "variableName", value: "_private" });
    });

    it("parses names with digits", () => {
      expect(parseWithOhm("x1")).toEqual({ type: "variableName", value: "x1" });
    });
  });

  describe("String literals", () => {
    it("parses simple double-quoted strings", () => {
      expect(parseWithOhm('"hello"')).toEqual({
        type: "string",
        segments: [{ type: "text", value: "hello" }],
      });
    });

    it("parses simple single-quoted strings", () => {
      expect(parseWithOhm("'hello'")).toEqual({
        type: "string",
        segments: [{ type: "text", value: "hello" }],
      });
    });

    it("parses strings with interpolation", () => {
      expect(parseWithOhm('"hello ${name}"')).toEqual({
        type: "string",
        segments: [
          { type: "text", value: "hello " },
          { type: "interpolation", expression: { type: "variableName", value: "name" } },
        ],
      });
    });

    it("parses strings with access chain interpolation", () => {
      expect(parseWithOhm('"${user.name}"')).toEqual({
        type: "string",
        segments: [
          {
            type: "interpolation",
            expression: {
              type: "valueAccess",
              base: { type: "variableName", value: "user" },
              chain: [{ kind: "property", name: "name" }],
            },
          },
        ],
      });
    });

    it("parses strings with escape sequences", () => {
      expect(parseWithOhm('"line1\\nline2"')).toEqual({
        type: "string",
        segments: [{ type: "text", value: "line1\nline2" }],
      });
    });

    it("parses empty strings", () => {
      expect(parseWithOhm('""')).toEqual({
        type: "string",
        segments: [],
      });
    });
  });

  describe("Multiline strings", () => {
    it("parses simple multiline strings", () => {
      expect(parseWithOhm('"""hello world"""')).toEqual({
        type: "multiLineString",
        segments: [{ type: "text", value: "hello world" }],
      });
    });

    it("parses multiline strings with interpolation", () => {
      expect(parseWithOhm('"""hello ${name}"""')).toEqual({
        type: "multiLineString",
        segments: [
          { type: "text", value: "hello " },
          { type: "interpolation", expression: { type: "variableName", value: "name" } },
        ],
      });
    });

    it("parses multiline strings with newlines", () => {
      expect(parseWithOhm('"""line1\nline2"""')).toEqual({
        type: "multiLineString",
        segments: [{ type: "text", value: "line1\nline2" }],
      });
    });
  });

  describe("Binary operations", () => {
    it("parses addition", () => {
      expect(parseWithOhm("a + b")).toEqual({
        type: "binOpExpression",
        operator: "+",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });
    });

    it("parses subtraction", () => {
      expect(parseWithOhm("a - b")).toEqual({
        type: "binOpExpression",
        operator: "-",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });
    });

    it("parses multiplication", () => {
      expect(parseWithOhm("a * b")).toEqual({
        type: "binOpExpression",
        operator: "*",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });
    });

    it("parses division", () => {
      expect(parseWithOhm("a / b")).toEqual({
        type: "binOpExpression",
        operator: "/",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });
    });

    it("parses comparison operators", () => {
      expect(parseWithOhm("a == b")).toEqual({
        type: "binOpExpression",
        operator: "==",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });

      expect(parseWithOhm("a != b")).toEqual({
        type: "binOpExpression",
        operator: "!=",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });

      expect(parseWithOhm("a < b")).toEqual({
        type: "binOpExpression",
        operator: "<",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });

      expect(parseWithOhm("a > b")).toEqual({
        type: "binOpExpression",
        operator: ">",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });

      expect(parseWithOhm("a <= b")).toEqual({
        type: "binOpExpression",
        operator: "<=",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });

      expect(parseWithOhm("a >= b")).toEqual({
        type: "binOpExpression",
        operator: ">=",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });
    });

    it("parses logical operators", () => {
      expect(parseWithOhm("a && b")).toEqual({
        type: "binOpExpression",
        operator: "&&",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });

      expect(parseWithOhm("a || b")).toEqual({
        type: "binOpExpression",
        operator: "||",
        left: { type: "variableName", value: "a" },
        right: { type: "variableName", value: "b" },
      });
    });

    it("respects precedence: * before +", () => {
      // a + b * c should parse as a + (b * c)
      expect(parseWithOhm("a + b * c")).toEqual({
        type: "binOpExpression",
        operator: "+",
        left: { type: "variableName", value: "a" },
        right: {
          type: "binOpExpression",
          operator: "*",
          left: { type: "variableName", value: "b" },
          right: { type: "variableName", value: "c" },
        },
      });
    });

    it("respects precedence: && before ||", () => {
      // a || b && c should parse as a || (b && c)
      expect(parseWithOhm("a || b && c")).toEqual({
        type: "binOpExpression",
        operator: "||",
        left: { type: "variableName", value: "a" },
        right: {
          type: "binOpExpression",
          operator: "&&",
          left: { type: "variableName", value: "b" },
          right: { type: "variableName", value: "c" },
        },
      });
    });

    it("is left-associative", () => {
      // a + b + c should parse as (a + b) + c
      expect(parseWithOhm("a + b + c")).toEqual({
        type: "binOpExpression",
        operator: "+",
        left: {
          type: "binOpExpression",
          operator: "+",
          left: { type: "variableName", value: "a" },
          right: { type: "variableName", value: "b" },
        },
        right: { type: "variableName", value: "c" },
      });
    });

    it("parses number binops", () => {
      expect(parseWithOhm("1 + 2")).toEqual({
        type: "binOpExpression",
        operator: "+",
        left: { type: "number", value: "1" },
        right: { type: "number", value: "2" },
      });
    });
  });

  describe("Function calls", () => {
    it("parses calls with no arguments", () => {
      expect(parseWithOhm("foo()")).toEqual({
        type: "functionCall",
        functionName: "foo",
        arguments: [],
      });
    });

    it("parses calls with one argument", () => {
      expect(parseWithOhm("greet(name)")).toEqual({
        type: "functionCall",
        functionName: "greet",
        arguments: [{ type: "variableName", value: "name" }],
      });
    });

    it("parses calls with multiple arguments", () => {
      expect(parseWithOhm("add(x, y)")).toEqual({
        type: "functionCall",
        functionName: "add",
        arguments: [
          { type: "variableName", value: "x" },
          { type: "variableName", value: "y" },
        ],
      });
    });

    it("parses nested function calls", () => {
      expect(parseWithOhm("outer(inner())")).toEqual({
        type: "functionCall",
        functionName: "outer",
        arguments: [
          { type: "functionCall", functionName: "inner", arguments: [] },
        ],
      });
    });

    it("parses function calls with literal arguments", () => {
      expect(parseWithOhm('test(42, "hello", true)')).toEqual({
        type: "functionCall",
        functionName: "test",
        arguments: [
          { type: "number", value: "42" },
          { type: "string", segments: [{ type: "text", value: "hello" }] },
          { type: "boolean", value: true },
        ],
      });
    });

    it("parses function calls with binop arguments", () => {
      expect(parseWithOhm("compute(a + b)")).toEqual({
        type: "functionCall",
        functionName: "compute",
        arguments: [
          {
            type: "binOpExpression",
            operator: "+",
            left: { type: "variableName", value: "a" },
            right: { type: "variableName", value: "b" },
          },
        ],
      });
    });
  });

  describe("Value access chains", () => {
    it("parses property access", () => {
      expect(parseWithOhm("obj.name")).toEqual({
        type: "valueAccess",
        base: { type: "variableName", value: "obj" },
        chain: [{ kind: "property", name: "name" }],
      });
    });

    it("parses chained property access", () => {
      expect(parseWithOhm("a.b.c")).toEqual({
        type: "valueAccess",
        base: { type: "variableName", value: "a" },
        chain: [
          { kind: "property", name: "b" },
          { kind: "property", name: "c" },
        ],
      });
    });

    it("parses index access", () => {
      expect(parseWithOhm("arr[0]")).toEqual({
        type: "valueAccess",
        base: { type: "variableName", value: "arr" },
        chain: [{ kind: "index", index: { type: "number", value: "0" } }],
      });
    });

    it("parses index access with variable", () => {
      expect(parseWithOhm("arr[i]")).toEqual({
        type: "valueAccess",
        base: { type: "variableName", value: "arr" },
        chain: [{ kind: "index", index: { type: "variableName", value: "i" } }],
      });
    });

    it("parses method calls", () => {
      expect(parseWithOhm("list.push(item)")).toEqual({
        type: "valueAccess",
        base: { type: "variableName", value: "list" },
        chain: [
          {
            kind: "methodCall",
            functionCall: {
              type: "functionCall",
              functionName: "push",
              arguments: [{ type: "variableName", value: "item" }],
            },
          },
        ],
      });
    });

    it("parses chained mixed access", () => {
      expect(parseWithOhm("data.items[0].name")).toEqual({
        type: "valueAccess",
        base: { type: "variableName", value: "data" },
        chain: [
          { kind: "property", name: "items" },
          { kind: "index", index: { type: "number", value: "0" } },
          { kind: "property", name: "name" },
        ],
      });
    });

    it("parses function call base with access", () => {
      expect(parseWithOhm("getData().name")).toEqual({
        type: "valueAccess",
        base: {
          type: "functionCall",
          functionName: "getData",
          arguments: [],
        },
        chain: [{ kind: "property", name: "name" }],
      });
    });

    it("parses function call base with index", () => {
      expect(parseWithOhm("getItems()[0]")).toEqual({
        type: "valueAccess",
        base: {
          type: "functionCall",
          functionName: "getItems",
          arguments: [],
        },
        chain: [{ kind: "index", index: { type: "number", value: "0" } }],
      });
    });
  });

  describe("Arrays", () => {
    it("parses empty arrays", () => {
      expect(parseWithOhm("[]")).toEqual({
        type: "agencyArray",
        items: [],
      });
    });

    it("parses arrays with items", () => {
      expect(parseWithOhm("[1, 2, 3]")).toEqual({
        type: "agencyArray",
        items: [
          { type: "number", value: "1" },
          { type: "number", value: "2" },
          { type: "number", value: "3" },
        ],
      });
    });

    it("parses arrays with trailing comma", () => {
      expect(parseWithOhm("[1, 2,]")).toEqual({
        type: "agencyArray",
        items: [
          { type: "number", value: "1" },
          { type: "number", value: "2" },
        ],
      });
    });

    it("parses nested arrays", () => {
      expect(parseWithOhm("[[1, 2], [3, 4]]")).toEqual({
        type: "agencyArray",
        items: [
          { type: "agencyArray", items: [{ type: "number", value: "1" }, { type: "number", value: "2" }] },
          { type: "agencyArray", items: [{ type: "number", value: "3" }, { type: "number", value: "4" }] },
        ],
      });
    });

    it("parses arrays with splat", () => {
      expect(parseWithOhm("[...items, extra]")).toEqual({
        type: "agencyArray",
        items: [
          { type: "splat", value: { type: "variableName", value: "items" } },
          { type: "variableName", value: "extra" },
        ],
      });
    });

    it("parses arrays with mixed types", () => {
      expect(parseWithOhm('[1, "hello", true, x]')).toEqual({
        type: "agencyArray",
        items: [
          { type: "number", value: "1" },
          { type: "string", segments: [{ type: "text", value: "hello" }] },
          { type: "boolean", value: true },
          { type: "variableName", value: "x" },
        ],
      });
    });
  });

  describe("Objects", () => {
    it("parses empty objects", () => {
      expect(parseWithOhm("{}")).toEqual({
        type: "agencyObject",
        entries: [],
      });
    });

    it("parses objects with entries", () => {
      expect(parseWithOhm('{name: "John", age: 30}')).toEqual({
        type: "agencyObject",
        entries: [
          { key: "name", value: { type: "string", segments: [{ type: "text", value: "John" }] } },
          { key: "age", value: { type: "number", value: "30" } },
        ],
      });
    });

    it("parses objects with quoted keys", () => {
      expect(parseWithOhm('{"my-key": 42}')).toEqual({
        type: "agencyObject",
        entries: [
          { key: "my-key", value: { type: "number", value: "42" } },
        ],
      });
    });

    it("parses objects with splat", () => {
      expect(parseWithOhm("{...config, timeout: 1000}")).toEqual({
        type: "agencyObject",
        entries: [
          { type: "splat", value: { type: "variableName", value: "config" } },
          { key: "timeout", value: { type: "number", value: "1000" } },
        ],
      });
    });

    it("parses objects with trailing comma", () => {
      expect(parseWithOhm("{a: 1, b: 2,}")).toEqual({
        type: "agencyObject",
        entries: [
          { key: "a", value: { type: "number", value: "1" } },
          { key: "b", value: { type: "number", value: "2" } },
        ],
      });
    });

    it("parses nested objects", () => {
      expect(parseWithOhm("{outer: {inner: 42}}")).toEqual({
        type: "agencyObject",
        entries: [
          {
            key: "outer",
            value: {
              type: "agencyObject",
              entries: [{ key: "inner", value: { type: "number", value: "42" } }],
            },
          },
        ],
      });
    });
  });

  describe("Complex expressions", () => {
    it("parses function call in binary op", () => {
      expect(parseWithOhm("len(arr) > 0")).toEqual({
        type: "binOpExpression",
        operator: ">",
        left: {
          type: "functionCall",
          functionName: "len",
          arguments: [{ type: "variableName", value: "arr" }],
        },
        right: { type: "number", value: "0" },
      });
    });

    it("parses access chain in binary op", () => {
      expect(parseWithOhm("obj.count + 1")).toEqual({
        type: "binOpExpression",
        operator: "+",
        left: {
          type: "valueAccess",
          base: { type: "variableName", value: "obj" },
          chain: [{ kind: "property", name: "count" }],
        },
        right: { type: "number", value: "1" },
      });
    });

    it("parses parenthesized expressions", () => {
      expect(parseWithOhm("(a + b) * c")).toEqual({
        type: "binOpExpression",
        operator: "*",
        left: {
          type: "binOpExpression",
          operator: "+",
          left: { type: "variableName", value: "a" },
          right: { type: "variableName", value: "b" },
        },
        right: { type: "variableName", value: "c" },
      });
    });
  });
});
