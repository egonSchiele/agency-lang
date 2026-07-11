import { describe, it, expect } from "vitest";
import { exprParser } from "./parsers.js";
import { parseAgency } from "../parser.js";

describe("exprParser", () => {
  describe("atoms", () => {
    it("should parse a number", () => {
      const result = exprParser("42");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({ type: "number", value: "42" });
      }
    });

    it("should parse a negative number literal", () => {
      const result = exprParser("-42");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({ type: "number", value: "-42" });
      }
    });

    it("should parse a variable name", () => {
      const result = exprParser("foo");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({ type: "variableName", value: "foo" });
      }
    });

    it("should parse a string", () => {
      const result = exprParser('"hello"');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("string");
      }
    });

    it("should parse a boolean", () => {
      const result = exprParser("true");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({ type: "boolean", value: true });
      }
    });

    it("should parse an array literal", () => {
      const result = exprParser("[1, 2, 3]");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("agencyArray");
      }
    });

    it("should parse an object literal", () => {
      const result = exprParser('{ key: "value" }');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("agencyObject");
      }
    });
  });

  describe("binary operations", () => {
    it("should parse addition", () => {
      const result = exprParser("1 + 2");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "+",
          left: { type: "number", value: "1" },
          right: { type: "number", value: "2" },
        });
      }
    });

    it("should respect precedence: * before +", () => {
      const result = exprParser("1 + 2 * 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "+",
          left: { type: "number", value: "1" },
          right: {
            type: "binOpExpression",
            operator: "*",
            left: { type: "number", value: "2" },
            right: { type: "number", value: "3" },
          },
        });
      }
    });

    it("should be left-associative: 1 - 2 - 3 = (1 - 2) - 3", () => {
      const result = exprParser("1 - 2 - 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "-",
          left: {
            type: "binOpExpression",
            operator: "-",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
          right: { type: "number", value: "3" },
        });
      }
    });

    it("should parse comparison operators", () => {
      const result = exprParser("a == b");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("==");
        }
      }
    });

    it("should parse logical operators with correct precedence", () => {
      const result = exprParser("a && b || c");
      expect(result.success).toBe(true);
      if (result.success) {
        // || is lower precedence than &&
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("||");
        }
      }
    });

    it("should parse assignment operators", () => {
      const result = exprParser("x += 1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("+=");
        }
      }
    });

    it("should parse variables with operators", () => {
      const result = exprParser("foo + bar");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "+",
          left: { type: "variableName", value: "foo" },
          right: { type: "variableName", value: "bar" },
        });
      }
    });
  });

  describe("parenthesized expressions", () => {
    it("should parse (expr)", () => {
      const result = exprParser("(42)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({ type: "number", value: "42" });
      }
    });

    it("should override precedence with parens", () => {
      const result = exprParser("(1 + 2) * 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "*",
          left: {
            type: "binOpExpression",
            operator: "+",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
          right: { type: "number", value: "3" },
        });
      }
    });

    it("should handle nested parens", () => {
      const result = exprParser("((1 + 2))");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
      }
    });

    it("should handle whitespace inside parens", () => {
      const result = exprParser("( 1 + 2 )");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
      }
    });
  });

  describe("unary operators", () => {
    it("should parse logical not", () => {
      const result = exprParser("!x");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "!",
          left: { type: "boolean", value: true },
          right: { type: "variableName", value: "x" },
        });
      }
    });

    it("should parse !x && y as (!x) && y", () => {
      const result = exprParser("!x && y");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("&&");
        }
      }
    });

    it("should parse double negation", () => {
      const result = exprParser("!!x");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("!");
          expect(result.result.right.type).toBe("binOpExpression");
        }
      }
    });
  });

  describe("value access and function calls", () => {
    it("should parse property access", () => {
      const result = exprParser("foo.bar");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("valueAccess");
      }
    });

    it("should parse function calls", () => {
      const result = exprParser("foo(1, 2)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("functionCall");
      }
    });

    it("should parse function call with expression in binary op", () => {
      const result = exprParser("foo() + 1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
      }
    });

    it("should parse method chain in binary op", () => {
      const result = exprParser("a.b() + c.d");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
      }
    });
  });

  describe("complex expressions", () => {
    it("should parse nested binary operations", () => {
      const result = exprParser("a + b * c - d");
      expect(result.success).toBe(true);
    });

    it("should parse comparison with arithmetic", () => {
      const result = exprParser("a + 1 == b * 2");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("==");
        }
      }
    });

    it("should parse logical expression with comparisons", () => {
      const result = exprParser("a > 0 && b < 10");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("&&");
        }
      }
    });

    it("should parse parenthesized subexpression in binary op", () => {
      const result = exprParser("(a + b) * (c + d)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("*");
          expect(result.result.left.type).toBe("binOpExpression");
          expect(result.result.right.type).toBe("binOpExpression");
        }
      }
    });

    it("should parse !condition in logical expression", () => {
      const result = exprParser("!done && count > 0");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        if (result.result.type === "binOpExpression") {
          expect(result.result.operator).toBe("&&");
        }
      }
    });
  });

  describe("pipe operator |>", () => {
    it("parses a simple pipe expression", () => {
      const result = exprParser("a |> b");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "|>",
          left: { type: "variableName", value: "a" },
          right: { type: "variableName", value: "b" },
        });
      }
    });

    it("parses chained pipe expressions left-to-right", () => {
      const result = exprParser("a |> b |> c");
      expect(result.success).toBe(true);
      if (result.success && result.result.type === "binOpExpression") {
        expect(result.result.operator).toBe("|>");
        expect(result.result.left).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "|>",
          left: { type: "variableName", value: "a" },
          right: { type: "variableName", value: "b" },
        });
      }
    });

    it("pipe has lower precedence than ||", () => {
      const result = exprParser("a || b |> c");
      expect(result.success).toBe(true);
      if (result.success && result.result.type === "binOpExpression") {
        expect(result.result.operator).toBe("|>");
        if (result.result.left.type === "binOpExpression") {
          expect(result.result.left.operator).toBe("||");
        }
      }
    });

    it("parses pipe with function call on right side", () => {
      const result = exprParser("a |> foo(10)");
      expect(result.success).toBe(true);
      if (result.success && result.result.type === "binOpExpression") {
        expect(result.result.operator).toBe("|>");
        expect(result.result.right.type).toBe("functionCall");
      }
    });
  });

  describe("schema expressions", () => {
    it("should parse schema(number)", () => {
      const result = exprParser("schema(number)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("schemaExpression");
        if (result.result.type === "schemaExpression") {
          expect(result.result.typeArg).toEqual({ type: "primitiveType", value: "number" });
        }
      }
    });

    it("should parse schema(Result<number>)", () => {
      const result = exprParser("schema(Result<number>)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("schemaExpression");
        if (result.result.type === "schemaExpression") {
          expect(result.result.typeArg.type).toBe("resultType");
        }
      }
    });

    it("should parse schema({name: string, age: number})", () => {
      const result = exprParser("schema({name: string, age: number})");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("schemaExpression");
        if (result.result.type === "schemaExpression") {
          expect(result.result.typeArg.type).toBe("objectType");
        }
      }
    });
  });

  describe("schema(...) chaining (issue #480)", () => {
    it("parses a chained call in expression position", () => {
      const result = exprParser('schema(number).parseJSON("[1]")');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toMatchObject({
          type: "valueAccess",
          base: { type: "schemaExpression", typeArg: { type: "primitiveType", value: "number" } },
          chain: [{ kind: "methodCall", functionCall: { functionName: "parseJSON" } }],
        });
      }
    });

    it("accepts a type-grammar argument on the chained form", () => {
      const result = exprParser('schema(number[]).parseJSON("[1]")');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toMatchObject({
          type: "valueAccess",
          base: { type: "schemaExpression", typeArg: { type: "arrayType" } },
        });
      }
    });

    it("parses a two-element chain", () => {
      const result = exprParser('schema(number).parseJSON("5").value');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toMatchObject({
          type: "valueAccess",
          base: { type: "schemaExpression" },
        });
        if (result.result.type === "valueAccess") {
          expect(result.result.chain).toHaveLength(2);
          expect(result.result.chain[1]).toMatchObject({ kind: "property", name: "value" });
        }
      }
    });

    it("commits on an optional-chain head too", () => {
      const result = exprParser('schema(number)?.parseJSON("[1]")');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toMatchObject({
          type: "valueAccess",
          base: { type: "schemaExpression" },
          chain: [{ kind: "methodCall", optional: true, functionCall: { functionName: "parseJSON" } }],
        });
      }
    });

    it("a malformed chain after the dot is a targeted parse error", () => {
      const parsed = parseAgency("node main() {\n  const r = schema(number).123\n  return r\n}", {}, false);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.message).toContain("expected a method call after schema(...)");
      }
    });

    function mainBody(source: string) {
      const parsed = parseAgency(`node main() {\n  ${source}\n  return 1\n}`, {}, false);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error("unreachable");
      const node = parsed.result.nodes.find((n) => n.type === "graphNode");
      if (!node || node.type !== "graphNode") throw new Error("no graphNode");
      return node.body;
    }

    it("statement position: chain on schema(...) is a schemaExpression-based access, not a call to schema", () => {
      // Parsed as functionCall("schema") with the chain attached before this
      // change — wrong node kind (undefined function, wrong codegen).
      // Deliberate shape change, spec section Design/site 2.
      const stmt = mainBody('schema(number).parseJSON("[1]")').find(
        (n) => n.type === "valueAccess" || n.type === "functionCall",
      );
      expect(stmt).toMatchObject({
        type: "valueAccess",
        base: { type: "schemaExpression" },
        chain: [{ kind: "methodCall", functionCall: { functionName: "parseJSON" } }],
      });
    });

    it("statement position: bare schema(T) keeps its legacy functionCall shape", () => {
      // The peek(dotParser) gate exists to preserve exactly this: a chainless
      // schema(T) statement still parses as a call to `schema` (the checker
      // flags it as reserved), NOT as a schemaExpression statement.
      const stmt = mainBody("schema(number)").find((n) => n.type === "functionCall");
      expect(stmt).toMatchObject({ type: "functionCall", functionName: "schema" });
    });

    it("assignment target: schema(T).foo = x still fails to parse", () => {
      // The assignment parser rejects any non-variableName base ("assignment
      // target must start with a variable name"), so this fails identically
      // before and after schema chains became parseable.
      const parsed = parseAgency("node main() {\n  schema(number).foo = 5\n  return 1\n}", {}, false);
      expect(parsed.success).toBe(false);
    });
  });

  describe("parens followed by an access chain", () => {
    it("parses (a + b).foo as ValueAccess { base: binOp, chain: [property foo] }", () => {
      const result = exprParser("(a + b).foo");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("valueAccess");
        if (result.result.type === "valueAccess") {
          expect(result.result.base.type).toBe("binOpExpression");
          expect(result.result.chain).toHaveLength(1);
          expect(result.result.chain[0].kind).toBe("property");
          if (result.result.chain[0].kind === "property") {
            expect(result.result.chain[0].name).toBe("foo");
          }
        }
      }
    });

    it("parses (arr)[0] as ValueAccess { base: variableName, chain: [index 0] }", () => {
      const result = exprParser("(arr)[0]");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("valueAccess");
        if (result.result.type === "valueAccess") {
          expect(result.result.chain).toHaveLength(1);
          expect(result.result.chain[0].kind).toBe("index");
        }
      }
    });

    it("parses (foo()).length as ValueAccess { base: functionCall, chain: [property length] }", () => {
      const result = exprParser("(foo()).length");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("valueAccess");
        if (result.result.type === "valueAccess") {
          expect(result.result.base.type).toBe("functionCall");
          expect(result.result.chain).toHaveLength(1);
        }
      }
    });

    it("parses (new Foo()).bump() with a method-call chain element", () => {
      const result = exprParser("(new Foo()).bump()");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("valueAccess");
        if (result.result.type === "valueAccess") {
          expect(result.result.base.type).toBe("newExpression");
          expect(result.result.chain).toHaveLength(1);
          expect(result.result.chain[0].kind).toBe("methodCall");
        }
      }
    });

    it("bare (a + b) (no chain) still parses as the inner binOp", () => {
      const result = exprParser("(a + b)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
      }
    });
  });
});
