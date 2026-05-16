import { describe, it, expect } from "vitest";
import {
  assignmentParser,
  bindingPatternParser,
  exprParser,
  forLoopParser,
  matchBlockParser,
  matchBlockParserCase,
  matchPatternParser,
} from "./parsers.js";

describe("bindingPatternParser", () => {
  describe("variable name binders", () => {
    it("parses a bare identifier", () => {
      const result = bindingPatternParser("foo");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "variableName", value: "foo" });
      expect(result.rest).toBe("");
    });

    it("parses _foo as a variableName, not a wildcard", () => {
      const result = bindingPatternParser("_foo");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "variableName", value: "_foo" });
      expect(result.rest).toBe("");
    });

    it("parses _bar followed by ', x' as variableName _bar leaving the rest", () => {
      const result = bindingPatternParser("_bar, x");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "variableName", value: "_bar" });
      expect(result.rest).toBe(", x");
    });
  });

  describe("wildcard pattern", () => {
    it("parses _ as a wildcard", () => {
      const result = bindingPatternParser("_");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "wildcardPattern" });
      expect(result.rest).toBe("");
    });

    it("parses _ followed by , as a wildcard leaving the rest", () => {
      const result = bindingPatternParser("_, x");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "wildcardPattern" });
      expect(result.rest).toBe(", x");
    });
  });

  describe("rest pattern", () => {
    it("parses ...rest", () => {
      const result = bindingPatternParser("...rest");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "restPattern",
        identifier: "rest",
      });
    });
  });

  describe("array binding patterns", () => {
    it("parses [a, b]", () => {
      const result = bindingPatternParser("[a, b]");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "arrayPattern",
        elements: [
          { type: "variableName", value: "a" },
          { type: "variableName", value: "b" },
        ],
      });
    });

    it("parses [a, _, b] with a wildcard", () => {
      const result = bindingPatternParser("[a, _, b]");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "arrayPattern",
        elements: [
          { type: "variableName", value: "a" },
          { type: "wildcardPattern" },
          { type: "variableName", value: "b" },
        ],
      });
    });

    it("parses [first, ...rest]", () => {
      const result = bindingPatternParser("[first, ...rest]");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "arrayPattern",
        elements: [
          { type: "variableName", value: "first" },
          { type: "restPattern", identifier: "rest" },
        ],
      });
    });

    it("parses nested array patterns [[a, b], c]", () => {
      const result = bindingPatternParser("[[a, b], c]");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "arrayPattern",
        elements: [
          {
            type: "arrayPattern",
            elements: [
              { type: "variableName", value: "a" },
              { type: "variableName", value: "b" },
            ],
          },
          { type: "variableName", value: "c" },
        ],
      });
    });

    it("rejects literals in binding position [1, 2]", () => {
      const result = bindingPatternParser("[1, 2]");
      expect(result.success).toBe(false);
    });

    it("rejects rest in non-final position [a, ...b, c]", () => {
      expect(() => bindingPatternParser("[a, ...b, c]")).toThrow(/rest.*last/i);
    });
  });

  describe("object binding patterns", () => {
    it("parses { name } as a shorthand", () => {
      const result = bindingPatternParser("{ name }");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "objectPattern",
        properties: [{ type: "objectPatternShorthand", name: "name" }],
      });
    });

    it("parses { name: n, age: a } as property:value pairs", () => {
      const result = bindingPatternParser("{ name: n, age: a }");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "objectPattern",
        properties: [
          {
            type: "objectPatternProperty",
            key: "name",
            value: { type: "variableName", value: "n" },
          },
          {
            type: "objectPatternProperty",
            key: "age",
            value: { type: "variableName", value: "a" },
          },
        ],
      });
    });

    it("parses { name, ...rest }", () => {
      const result = bindingPatternParser("{ name, ...rest }");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "objectPattern",
        properties: [
          { type: "objectPatternShorthand", name: "name" },
          { type: "restPattern", identifier: "rest" },
        ],
      });
    });

    it("parses nested object pattern with array value { coords: [x, y] }", () => {
      const result = bindingPatternParser("{ coords: [x, y] }");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "objectPattern",
        properties: [
          {
            type: "objectPatternProperty",
            key: "coords",
            value: {
              type: "arrayPattern",
              elements: [
                { type: "variableName", value: "x" },
                { type: "variableName", value: "y" },
              ],
            },
          },
        ],
      });
    });

    it("parses doubly nested { address: { street, city } }", () => {
      const result = bindingPatternParser("{ address: { street, city } }");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "objectPattern",
        properties: [
          {
            type: "objectPatternProperty",
            key: "address",
            value: {
              type: "objectPattern",
              properties: [
                { type: "objectPatternShorthand", name: "street" },
                { type: "objectPatternShorthand", name: "city" },
              ],
            },
          },
        ],
      });
    });
  });

  describe("loc info", () => {
    it("attaches loc to wildcard, rest, array, and object patterns", () => {
      const wildcard = bindingPatternParser("_");
      expect(wildcard.success).toBe(true);
      if (wildcard.success) expect((wildcard.result as any).loc).toBeDefined();

      const rest = bindingPatternParser("...rest");
      expect(rest.success).toBe(true);
      if (rest.success) expect((rest.result as any).loc).toBeDefined();

      const arr = bindingPatternParser("[a, b]");
      expect(arr.success).toBe(true);
      if (arr.success) expect((arr.result as any).loc).toBeDefined();

      const obj = bindingPatternParser("{ a }");
      expect(obj.success).toBe(true);
      if (obj.success) expect((obj.result as any).loc).toBeDefined();
    });
  });
});

describe("matchPatternParser", () => {
  describe("re-tests of binding-style patterns", () => {
    it("parses a bare identifier", () => {
      const result = matchPatternParser("foo");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "variableName", value: "foo" });
    });

    it("parses _ as a wildcard", () => {
      const result = matchPatternParser("_");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "wildcardPattern" });
    });

    it("parses _foo as a variableName, not a wildcard", () => {
      const result = matchPatternParser("_foo");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "variableName", value: "_foo" });
      expect(result.rest).toBe("");
    });

    it("parses [first, ...rest]", () => {
      const result = matchPatternParser("[first, ...rest]");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "arrayPattern",
        elements: [
          { type: "variableName", value: "first" },
          { type: "restPattern", identifier: "rest" },
        ],
      });
    });

    it("parses { name, ...rest }", () => {
      const result = matchPatternParser("{ name, ...rest }");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "objectPattern",
        properties: [
          { type: "objectPatternShorthand", name: "name" },
          { type: "restPattern", identifier: "rest" },
        ],
      });
    });
  });

  describe("literal patterns", () => {
    it('parses "foo"', () => {
      const result = matchPatternParser('"foo"');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "string",
        segments: [{ type: "text", value: "foo" }],
      });
    });

    it("parses 42", () => {
      const result = matchPatternParser("42");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "number", value: "42" });
    });

    it("parses true", () => {
      const result = matchPatternParser("true");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "boolean", value: true });
    });

    it("parses false", () => {
      const result = matchPatternParser("false");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "boolean", value: false });
    });

    it("parses null", () => {
      const result = matchPatternParser("null");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({ type: "null" });
    });
  });

  describe("mixed literal + binder patterns", () => {
    it('parses { type: "showPolicy", policy }', () => {
      const result = matchPatternParser('{ type: "showPolicy", policy }');
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "objectPattern",
        properties: [
          {
            type: "objectPatternProperty",
            key: "type",
            value: {
              type: "string",
              segments: [{ type: "text", value: "showPolicy" }],
            },
          },
          { type: "objectPatternShorthand", name: "policy" },
        ],
      });
    });

    it("parses [1, x, 3]", () => {
      const result = matchPatternParser("[1, x, 3]");
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.result).toMatchObject({
        type: "arrayPattern",
        elements: [
          { type: "number", value: "1" },
          { type: "variableName", value: "x" },
          { type: "number", value: "3" },
        ],
      });
    });
  });

  describe("array rest enforcement (match patterns too)", () => {
    it("rejects rest in non-final position [a, ...b, c]", () => {
      expect(() => matchPatternParser("[a, ...b, c]")).toThrow(/rest.*last/i);
    });
  });
});

// =============================================================================
// Integration tests for pattern syntax wired into existing parsers
// =============================================================================

describe("assignmentParser with destructuring", () => {
  it("parses `let [a, b] = items`", () => {
    const result = assignmentParser("let [a, b] = items");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "assignment",
      declKind: "let",
      variableName: "__destructured",
      pattern: {
        type: "arrayPattern",
        elements: [
          { type: "variableName", value: "a" },
          { type: "variableName", value: "b" },
        ],
      },
      value: { type: "variableName", value: "items" },
    });
  });

  it("parses `const { name, age } = person`", () => {
    const result = assignmentParser("const { name, age } = person");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "assignment",
      declKind: "const",
      variableName: "__destructured",
      pattern: {
        type: "objectPattern",
        properties: [
          { type: "objectPatternShorthand", name: "name" },
          { type: "objectPatternShorthand", name: "age" },
        ],
      },
      value: { type: "variableName", value: "person" },
    });
  });

  it("still parses `let x = 5` as a simple assignment with no pattern", () => {
    const result = assignmentParser("let x = 5");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "assignment",
      declKind: "let",
      variableName: "x",
      value: { type: "number", value: "5" },
    });
    expect((result.result as any).pattern).toBeUndefined();
  });

  it("destructuring assignment carries a loc", () => {
    const result = assignmentParser("let [a, b] = items");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.result as any).loc).toBeDefined();
  });
});

describe("matchBlockParserCase with patterns and guards", () => {
  it("parses an arm with an object pattern", () => {
    const result = matchBlockParserCase('{ type: "show", v } => f(v)');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "matchBlockCase",
      caseValue: {
        type: "objectPattern",
        properties: [
          {
            type: "objectPatternProperty",
            key: "type",
            value: { type: "string", segments: [{ type: "text", value: "show" }] },
          },
          { type: "objectPatternShorthand", name: "v" },
        ],
      },
      body: {
        type: "functionCall",
        functionName: "f",
      },
    });
  });

  it("parses an arm with a guard", () => {
    const result = matchBlockParserCase("{ s, b } if (s > 5) => f(b)");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "matchBlockCase",
      caseValue: {
        type: "objectPattern",
        properties: [
          { type: "objectPatternShorthand", name: "s" },
          { type: "objectPatternShorthand", name: "b" },
        ],
      },
      guard: {
        type: "binOpExpression",
        operator: ">",
        left: { type: "variableName", value: "s" },
        right: { type: "number", value: "5" },
      },
      body: {
        type: "functionCall",
        functionName: "f",
      },
    });
  });

  it("parses a default arm `_ => g()` (no guard, no pattern field)", () => {
    const result = matchBlockParserCase("_ => g()");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "matchBlockCase",
      caseValue: "_",
      body: { type: "functionCall", functionName: "g" },
    });
    expect((result.result as any).guard).toBeUndefined();
  });

  it("parses an arm with a literal pattern (existing syntax)", () => {
    const result = matchBlockParserCase('"a" => 1');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "matchBlockCase",
      caseValue: { type: "string", segments: [{ type: "text", value: "a" }] },
      body: { type: "number", value: "1" },
    });
  });
});

describe("matchBlockParser with `is` expression as scrutinee", () => {
  it("parses `match(response is { status, body }) { _ => g() }`", () => {
    const result = matchBlockParser(
      "match(response is { status, body }) { _ => g() }",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "matchBlock",
      expression: {
        type: "isExpression",
        expression: { type: "variableName", value: "response" },
        pattern: {
          type: "objectPattern",
          properties: [
            { type: "objectPatternShorthand", name: "status" },
            { type: "objectPatternShorthand", name: "body" },
          ],
        },
      },
    });
  });

  it("still parses a plain match block (existing syntax)", () => {
    const result = matchBlockParser('match(x) { "a" => 1; _ => 2 }');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "matchBlock",
      expression: { type: "variableName", value: "x" },
    });
  });
});

describe("forLoopParser with destructuring", () => {
  it("parses `for ([k, v] in entries) { print(k) }`", () => {
    const result = forLoopParser("for ([k, v] in entries) { print(k) }");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "forLoop",
      itemVar: {
        type: "arrayPattern",
        elements: [
          { type: "variableName", value: "k" },
          { type: "variableName", value: "v" },
        ],
      },
      iterable: { type: "variableName", value: "entries" },
    });
  });

  it("parses `for ({ name, age } in users) { print(name) }`", () => {
    const result = forLoopParser(
      "for ({ name, age } in users) { print(name) }",
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "forLoop",
      itemVar: {
        type: "objectPattern",
        properties: [
          { type: "objectPatternShorthand", name: "name" },
          { type: "objectPatternShorthand", name: "age" },
        ],
      },
      iterable: { type: "variableName", value: "users" },
    });
  });

  it("still parses a plain `for (item in items) { ... }`", () => {
    const result = forLoopParser("for (item in items) {\n  print(item)\n}");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "forLoop",
      itemVar: "item",
      iterable: { type: "variableName", value: "items" },
    });
  });
});

describe("exprParser with `is` expression", () => {
  it("parses `step is { type: \"showPolicy\" }` as an IsExpression", () => {
    const result = exprParser('step is { type: "showPolicy" }');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "isExpression",
      expression: { type: "variableName", value: "step" },
      pattern: {
        type: "objectPattern",
        properties: [
          {
            type: "objectPatternProperty",
            key: "type",
            value: {
              type: "string",
              segments: [{ type: "text", value: "showPolicy" }],
            },
          },
        ],
      },
    });
  });

  it("parses `x is { a } && y > 5` with IsExpression on the LHS of &&", () => {
    const result = exprParser("x is { a } && y > 5");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "binOpExpression",
      operator: "&&",
      left: {
        type: "isExpression",
        expression: { type: "variableName", value: "x" },
        pattern: {
          type: "objectPattern",
          properties: [{ type: "objectPatternShorthand", name: "a" }],
        },
      },
      right: {
        type: "binOpExpression",
        operator: ">",
        left: { type: "variableName", value: "y" },
        right: { type: "number", value: "5" },
      },
    });
  });

  it("parses RHS of `let r = step is { type: \"showPolicy\" }` as IsExpression", () => {
    const result = assignmentParser('let r = step is { type: "showPolicy" }');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "assignment",
      declKind: "let",
      variableName: "r",
      value: {
        type: "isExpression",
        expression: { type: "variableName", value: "step" },
        pattern: { type: "objectPattern" },
      },
    });
  });

  it("does not match `is` inside an identifier like `island`", () => {
    const result = exprParser("island");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({ type: "variableName", value: "island" });
  });

  it("still parses `x == 5` (existing syntax)", () => {
    const result = exprParser("x == 5");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "binOpExpression",
      operator: "==",
      left: { type: "variableName", value: "x" },
      right: { type: "number", value: "5" },
    });
  });
});
