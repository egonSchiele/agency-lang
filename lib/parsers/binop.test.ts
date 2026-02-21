import { describe, it, expect } from "vitest";
import { binOpParser } from "./binop.js";

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
          expect(result.result).toEqual(expected.result);
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
          expect(result.result).toEqual(expected.result);
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
          expect(result.result).toEqual(expected.result);
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
          expect(result.result).toEqual(expected.result);
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
          expect(result.result).toEqual(expected.result);
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
        expect(result.result).toEqual({
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
        expect(result.result).toEqual({
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
        expect(result.result).toEqual({
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
        expect(result.result).toEqual({
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
        expect(result.result).toEqual({
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

  // Failure cases
  describe("failure cases", () => {
    const failureCases = [
      { input: "", description: "empty string" },
      { input: "1 +", description: "missing right operand" },
      { input: "+ 2", description: "missing left operand" },
      { input: "1 % 2", description: "unsupported operator" },
      { input: "1 && 2", description: "unsupported logical operator" },
    ];

    failureCases.forEach(({ input, description }) => {
      it(`should fail to parse ${description}: "${input}"`, () => {
        const result = binOpParser(input);
        expect(result.success).toBe(false);
      });
    });
  });
});
