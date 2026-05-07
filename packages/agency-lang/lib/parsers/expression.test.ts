import { describe, it, expect } from "vitest";
import { exprParser } from "./parsers.js";

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
});
