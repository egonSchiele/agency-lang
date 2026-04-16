import { describe, it, expect } from "vitest";
import { binOpParser } from "./parsers.js";

describe("binOpParser", () => {
  // Arithmetic operators
  describe("arithmetic operators", () => {
    const testCases = [
      {
        input: "1 + 2",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "+",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
        },
      },
      {
        input: "10 - 3",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "-",
            left: { type: "number", value: "10" },
            right: { type: "number", value: "3" },
          },
        },
      },
      {
        input: "4 * 5",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "*",
            left: { type: "number", value: "4" },
            right: { type: "number", value: "5" },
          },
        },
      },
      {
        input: "10 / 2",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "/",
            left: { type: "number", value: "10" },
            right: { type: "number", value: "2" },
          },
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = binOpParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    });
  });

  // Comparison operators
  describe("comparison operators", () => {
    const testCases = [
      {
        input: "1 < 2",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "<",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
        },
      },
      {
        input: "5 > 3",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: ">",
            left: { type: "number", value: "5" },
            right: { type: "number", value: "3" },
          },
        },
      },
      {
        input: "1 == 1",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "==",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "1" },
          },
        },
      },
      {
        input: "1 != 2",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "!=",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
        },
      },
      {
        input: "3 <= 5",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "<=",
            left: { type: "number", value: "3" },
            right: { type: "number", value: "5" },
          },
        },
      },
      {
        input: "5 >= 3",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: ">=",
            left: { type: "number", value: "5" },
            right: { type: "number", value: "3" },
          },
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = binOpParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    });
  });

  // Variable operands
  describe("variable operands", () => {
    const testCases = [
      {
        input: "x + y",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "+",
            left: { type: "variableName", value: "x" },
            right: { type: "variableName", value: "y" },
          },
        },
      },
      {
        input: "count == 0",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "==",
            left: { type: "variableName", value: "count" },
            right: { type: "number", value: "0" },
          },
        },
      },
      {
        input: "score > 100",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: ">",
            left: { type: "variableName", value: "score" },
            right: { type: "number", value: "100" },
          },
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = binOpParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    });
  });

  // Boolean operands
  describe("boolean operands", () => {
    const testCases = [
      {
        input: "true == false",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "==",
            left: { type: "boolean", value: true },
            right: { type: "boolean", value: false },
          },
        },
      },
      {
        input: "done != true",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "!=",
            left: { type: "variableName", value: "done" },
            right: { type: "boolean", value: true },
          },
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = binOpParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    });
  });

  // No spaces around operator
  describe("no spaces around operator", () => {
    const testCases = [
      {
        input: "1+2",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "+",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
        },
      },
      {
        input: "3*4",
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "*",
            left: { type: "number", value: "3" },
            right: { type: "number", value: "4" },
          },
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = binOpParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    });
  });

  // With optional semicolon
  describe("with optional semicolon", () => {
    it('should parse "1 + 2;" successfully', () => {
      const result = binOpParser("1 + 2;");
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

    it('should parse "x == y;" successfully', () => {
      const result = binOpParser("x == y;");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "==",
          left: { type: "variableName", value: "x" },
          right: { type: "variableName", value: "y" },
        });
      }
    });
  });

  // ValueAccess operands
  describe("valueAccess operands", () => {
    it('should parse "obj.count + 1"', () => {
      const result = binOpParser("obj.count + 1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "+",
          left: {
            type: "valueAccess",
            base: { type: "variableName", value: "obj" },
            chain: [{ kind: "property", name: "count" }],
          },
          right: { type: "number", value: "1" },
        });
      }
    });

    it('should parse "arr[0] == \\"done\\""', () => {
      const result = binOpParser('arr[0] == "done"');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "==",
          left: {
            type: "valueAccess",
            base: { type: "variableName", value: "arr" },
            chain: [{ kind: "index", index: { type: "number", value: "0" } }],
          },
          right: { type: "string", segments: [{ type: "text", value: "done" }] },
        });
      }
    });

    it('should parse "response.status >= 400"', () => {
      const result = binOpParser("response.status >= 400");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: ">=",
          left: {
            type: "valueAccess",
            base: { type: "variableName", value: "response" },
            chain: [{ kind: "property", name: "status" }],
          },
          right: { type: "number", value: "400" },
        });
      }
    });
  });

  // Logical operators
  describe("logical operators", () => {
    it('should parse "x && y"', () => {
      const result = binOpParser("x && y");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "&&",
          left: { type: "variableName", value: "x" },
          right: { type: "variableName", value: "y" },
        });
      }
    });

    it('should parse "a || b"', () => {
      const result = binOpParser("a || b");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "||",
          left: { type: "variableName", value: "a" },
          right: { type: "variableName", value: "b" },
        });
      }
    });
  });

  // Chaining (left-associative)
  describe("chaining", () => {
    it('should parse "1 + 2 + 3" as left-associative', () => {
      const result = binOpParser("1 + 2 + 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "+",
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
  });

  // Precedence
  describe("precedence", () => {
    it('should parse "1 + 2 * 3" with correct precedence', () => {
      const result = binOpParser("1 + 2 * 3");
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

    it('should parse "1 * 2 + 3 * 4" with correct precedence', () => {
      const result = binOpParser("1 * 2 + 3 * 4");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "+",
          left: {
            type: "binOpExpression",
            operator: "*",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
          right: {
            type: "binOpExpression",
            operator: "*",
            left: { type: "number", value: "3" },
            right: { type: "number", value: "4" },
          },
        });
      }
    });
  });

  // Assignment operators
  describe("assignment operators", () => {
    it('should parse "x += 5"', () => {
      const result = binOpParser("x += 5");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "+=",
          left: { type: "variableName", value: "x" },
          right: { type: "number", value: "5" },
        });
      }
    });

    it('should parse "count -= 1"', () => {
      const result = binOpParser("count -= 1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "-=",
          left: { type: "variableName", value: "count" },
          right: { type: "number", value: "1" },
        });
      }
    });

    it('should parse "x *= 2"', () => {
      const result = binOpParser("x *= 2");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "*=",
          left: { type: "variableName", value: "x" },
          right: { type: "number", value: "2" },
        });
      }
    });

    it('should parse "x /= 3"', () => {
      const result = binOpParser("x /= 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "/=",
          left: { type: "variableName", value: "x" },
          right: { type: "number", value: "3" },
        });
      }
    });
  });

  // Multiple operators with mixed precedence
  describe("multiple operators with mixed precedence", () => {
    it('should parse "1 + 2 * 3 - 4 / 5" with correct precedence', () => {
      const result = binOpParser("1 + 2 * 3 - 4 / 5");
      expect(result.success).toBe(true);
      if (result.success) {
        // Should parse as (1 + (2 * 3)) - (4 / 5)
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "-",
          left: {
            type: "binOpExpression",
            operator: "+",
            left: { type: "number", value: "1" },
            right: {
              type: "binOpExpression",
              operator: "*",
              left: { type: "number", value: "2" },
              right: { type: "number", value: "3" },
            },
          },
          right: {
            type: "binOpExpression",
            operator: "/",
            left: { type: "number", value: "4" },
            right: { type: "number", value: "5" },
          },
        });
      }
    });
  });

  // Nullish coalescing operator
  describe("nullish coalescing operator", () => {
    it('should parse "a ?? b"', () => {
      const result = binOpParser("a ?? b");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "??",
          left: { type: "variableName", value: "a" },
          right: { type: "variableName", value: "b" },
        });
      }
    });

    it('should parse "a ?? b ?? c" as left-associative', () => {
      const result = binOpParser("a ?? b ?? c");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "??",
          left: {
            type: "binOpExpression",
            operator: "??",
            left: { type: "variableName", value: "a" },
            right: { type: "variableName", value: "b" },
          },
          right: { type: "variableName", value: "c" },
        });
      }
    });

    it('should parse "a ?? 42"', () => {
      const result = binOpParser("a ?? 42");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "??",
          left: { type: "variableName", value: "a" },
          right: { type: "number", value: "42" },
        });
      }
    });

    it('should parse ?? with lower precedence than comparison', () => {
      const result = binOpParser("a == b ?? c");
      expect(result.success).toBe(true);
      if (result.success) {
        // Should parse as (a == b) ?? c
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "??",
          left: {
            type: "binOpExpression",
            operator: "==",
            left: { type: "variableName", value: "a" },
            right: { type: "variableName", value: "b" },
          },
          right: { type: "variableName", value: "c" },
        });
      }
    });
  });

  // Strict inequality operator
  describe("strict inequality operator", () => {
    it('should parse "a !== b"', () => {
      const result = binOpParser("a !== b");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "!==",
          left: { type: "variableName", value: "a" },
          right: { type: "variableName", value: "b" },
        });
      }
    });
  });

  // Exponentiation operator
  describe("exponentiation operator", () => {
    it('should parse "2 ** 3"', () => {
      const result = binOpParser("2 ** 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "**",
          left: { type: "number", value: "2" },
          right: { type: "number", value: "3" },
        });
      }
    });

    it('should parse "2 ** 3 ** 4" as right-associative', () => {
      const result = binOpParser("2 ** 3 ** 4");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "**",
          left: { type: "number", value: "2" },
          right: {
            type: "binOpExpression",
            operator: "**",
            left: { type: "number", value: "3" },
            right: { type: "number", value: "4" },
          },
        });
      }
    });

    it('should parse ** with higher precedence than *', () => {
      const result = binOpParser("2 * 3 ** 4");
      expect(result.success).toBe(true);
      if (result.success) {
        // Should parse as 2 * (3 ** 4)
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "*",
          left: { type: "number", value: "2" },
          right: {
            type: "binOpExpression",
            operator: "**",
            left: { type: "number", value: "3" },
            right: { type: "number", value: "4" },
          },
        });
      }
    });
  });

  // Compound assignment operators
  describe("compound assignment operators", () => {
    it('should parse "x ??= 5"', () => {
      const result = binOpParser("x ??= 5");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "??=",
          left: { type: "variableName", value: "x" },
          right: { type: "number", value: "5" },
        });
      }
    });

    it('should parse "x ||= 5"', () => {
      const result = binOpParser("x ||= 5");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "||=",
          left: { type: "variableName", value: "x" },
          right: { type: "number", value: "5" },
        });
      }
    });

    it('should parse "x &&= true"', () => {
      const result = binOpParser("x &&= true");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "&&=",
          left: { type: "variableName", value: "x" },
          right: { type: "boolean", value: true },
        });
      }
    });
  });

  // Postfix increment/decrement operators
  describe("postfix operators", () => {
    it('should parse "a++"', () => {
      const result = binOpParser("a++");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "++",
          left: { type: "variableName", value: "a" },
          right: { type: "boolean", value: true },
        });
      }
    });

    it('should parse "a--"', () => {
      const result = binOpParser("a--");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "--",
          left: { type: "variableName", value: "a" },
          right: { type: "boolean", value: true },
        });
      }
    });

    it('should parse "a++ + b" with correct precedence', () => {
      const result = binOpParser("a++ + b");
      expect(result.success).toBe(true);
      if (result.success) {
        // ++ binds tighter than +: (a++) + b
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "+",
          left: {
            type: "binOpExpression",
            operator: "++",
            left: { type: "variableName", value: "a" },
            right: { type: "boolean", value: true },
          },
          right: { type: "variableName", value: "b" },
        });
      }
    });
  });

  // typeof operator (unary)
  describe("typeof operator", () => {
    it('should parse "typeof x"', () => {
      const result = binOpParser("typeof x");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "typeof",
          left: { type: "boolean", value: true },
          right: { type: "variableName", value: "x" },
        });
      }
    });

    it('should parse "typeof x == \\"string\\""', () => {
      const result = binOpParser('typeof x == "string"');
      expect(result.success).toBe(true);
      if (result.success) {
        // typeof binds tighter: (typeof x) == "string"
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "==",
          left: {
            type: "binOpExpression",
            operator: "typeof",
            left: { type: "boolean", value: true },
            right: { type: "variableName", value: "x" },
          },
          right: { type: "string", segments: [{ type: "text", value: "string" }] },
        });
      }
    });
  });

  // void operator (unary)
  describe("void operator", () => {
    it('should parse "void 0"', () => {
      const result = binOpParser("void 0");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "void",
          left: { type: "boolean", value: true },
          right: { type: "number", value: "0" },
        });
      }
    });
  });

  // instanceof operator (binary)
  describe("instanceof operator", () => {
    it('should parse "x instanceof Array"', () => {
      const result = binOpParser("x instanceof Array");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "instanceof",
          left: { type: "variableName", value: "x" },
          right: { type: "variableName", value: "Array" },
        });
      }
    });
  });

  // in operator (binary)
  describe("in operator", () => {
    it('should parse "\\"key\\" in obj"', () => {
      const result = binOpParser('"key" in obj');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqualWithoutLoc({
          type: "binOpExpression",
          operator: "in",
          left: { type: "string", segments: [{ type: "text", value: "key" }] },
          right: { type: "variableName", value: "obj" },
        });
      }
    });
  });

  // Failure cases
  describe("regex match operators", () => {
    const testCases = [
      {
        input: 'foo =~ /bar/',
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "=~",
            left: { type: "variableName", value: "foo" },
            right: { type: "regex", pattern: "bar", flags: "" },
          },
        },
      },
      {
        input: 'foo !~ /bar/i',
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "!~",
            left: { type: "variableName", value: "foo" },
            right: { type: "regex", pattern: "bar", flags: "i" },
          },
        },
      },
      {
        input: 'name =~ /^hello/',
        expected: {
          success: true,
          result: {
            type: "binOpExpression",
            operator: "=~",
            left: { type: "variableName", value: "name" },
            right: { type: "regex", pattern: "^hello", flags: "" },
          },
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = binOpParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    });
  });

  describe("failure cases", () => {
    const failureCases = [
      { input: "", description: "empty string" },
      { input: "1 +", description: "missing right operand" },
      { input: "+ 2", description: "missing left operand" },
      { input: "1 ^ 2", description: "unsupported operator" },
    ];

    failureCases.forEach(({ input, description }) => {
      it(`should fail to parse ${description}: "${input}"`, () => {
        const result = binOpParser(input);
        expect(result.success).toBe(false);
      });
    });
  });
});
