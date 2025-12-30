import { describe, it, expect } from "vitest";
import {
  primitiveTypeParser,
  arrayTypeParser,
  angleBracketsArrayTypeParser,
  stringLiteralTypeParser,
  numberLiteralTypeParser,
  booleanLiteralTypeParser,
  variableTypeParser,
  typeHintParser,
} from "./typeHints";

describe("primitiveTypeParser", () => {
  const testCases = [
    {
      input: "number",
      expected: {
        success: true,
        result: { type: "primitiveType", value: "number" },
      },
    },
    {
      input: "string",
      expected: {
        success: true,
        result: { type: "primitiveType", value: "string" },
      },
    },
    {
      input: "boolean",
      expected: {
        success: true,
        result: { type: "primitiveType", value: "boolean" },
      },
    },
    {
      input: "invalid",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = primitiveTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = primitiveTypeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("arrayTypeParser", () => {
  const testCases = [
    {
      input: "number[]",
      expected: {
        success: true,
        result: {
          type: "arrayType",
          elementType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "string[]",
      expected: {
        success: true,
        result: {
          type: "arrayType",
          elementType: { type: "primitiveType", value: "string" },
        },
      },
    },
    {
      input: "boolean[]",
      expected: {
        success: true,
        result: {
          type: "arrayType",
          elementType: { type: "primitiveType", value: "boolean" },
        },
      },
    },
    {
      input: "number",
      expected: { success: false },
    },
    {
      input: "invalid[]",
      expected: { success: false },
    },
    {
      input: "[]",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = arrayTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = arrayTypeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("angleBracketsArrayTypeParser", () => {
  const testCases = [
    {
      input: "array<number>",
      expected: {
        success: true,
        result: {
          type: "arrayType",
          elementType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "array<string>",
      expected: {
        success: true,
        result: {
          type: "arrayType",
          elementType: { type: "primitiveType", value: "string" },
        },
      },
    },
    {
      input: "array<boolean>",
      expected: {
        success: true,
        result: {
          type: "arrayType",
          elementType: { type: "primitiveType", value: "boolean" },
        },
      },
    },
    {
      input: "array<invalid>",
      expected: { success: false },
    },
    {
      input: "array<>",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = angleBracketsArrayTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = angleBracketsArrayTypeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("stringLiteralTypeParser", () => {
  const testCases = [
    {
      input: '"hello"',
      expected: {
        success: true,
        result: { type: "stringLiteralType", value: "hello" },
      },
    },
    {
      input: '"world"',
      expected: {
        success: true,
        result: { type: "stringLiteralType", value: "world" },
      },
    },
    {
      input: '""',
      expected: { success: false },
    },
    {
      input: '"unterminated',
      expected: { success: false },
    },
    {
      input: 'unterminated"',
      expected: { success: false },
    },
    {
      input: "hello",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse ${input} successfully`, () => {
        const result = stringLiteralTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse ${input}`, () => {
        const result = stringLiteralTypeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("numberLiteralTypeParser", () => {
  const testCases = [
    {
      input: "42",
      expected: {
        success: true,
        result: { type: "numberLiteralType", value: "42" },
      },
    },
    {
      input: "0",
      expected: {
        success: true,
        result: { type: "numberLiteralType", value: "0" },
      },
    },
    {
      input: "123456",
      expected: {
        success: true,
        result: { type: "numberLiteralType", value: "123456" },
      },
    },
    {
      input: "-10",
      expected: {
        success: true,
        result: { type: "numberLiteralType", value: "-10" },
      },
    },

    {
      input: "10.15",
      expected: {
        success: true,
        result: { type: "numberLiteralType", value: "10.15" },
      },
    },
    {
      input: "abc",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = numberLiteralTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = numberLiteralTypeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("booleanLiteralTypeParser", () => {
  const testCases = [
    {
      input: "true",
      expected: {
        success: true,
        result: { type: "booleanLiteralType", value: "true" },
      },
    },
    {
      input: "false",
      expected: {
        success: true,
        result: { type: "booleanLiteralType", value: "false" },
      },
    },
    {
      input: "True",
      expected: { success: false },
    },
    {
      input: "FALSE",
      expected: { success: false },
    },
    {
      input: "1",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = booleanLiteralTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = booleanLiteralTypeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("variableTypeParser", () => {
  const testCases = [
    {
      input: "number",
      expected: {
        success: true,
        result: { type: "primitiveType", value: "number" },
      },
    },
    {
      input: "string[]",
      expected: {
        success: true,
        result: {
          type: "arrayType",
          elementType: { type: "primitiveType", value: "string" },
        },
      },
    },
    {
      input: "array<boolean>",
      expected: {
        success: true,
        result: {
          type: "arrayType",
          elementType: { type: "primitiveType", value: "boolean" },
        },
      },
    },
    {
      input: '"hello"',
      expected: {
        success: true,
        result: { type: "stringLiteralType", value: "hello" },
      },
    },
    {
      input: "42",
      expected: {
        success: true,
        result: { type: "numberLiteralType", value: "42" },
      },
    },
    {
      input: "true",
      expected: {
        success: true,
        result: { type: "booleanLiteralType", value: "true" },
      },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = variableTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = variableTypeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("typeHintParser", () => {
  const testCases = [
    {
      input: "bar :: number",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "bar",
          variableType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "test :: string",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "test",
          variableType: { type: "primitiveType", value: "string" },
        },
      },
    },
    {
      input: "items :: number[]",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "items",
          variableType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
        },
      },
    },
    {
      input: "list :: array<string>",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "list",
          variableType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "string" },
          },
        },
      },
    },
    {
      input: 'name :: "Alice"',
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "name",
          variableType: { type: "stringLiteralType", value: "Alice" },
        },
      },
    },
    {
      input: "count :: 42",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "count",
          variableType: { type: "numberLiteralType", value: "42" },
        },
      },
    },
    {
      input: "flag :: true",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "flag",
          variableType: { type: "booleanLiteralType", value: "true" },
        },
      },
    },
    {
      input: "x :: number",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "x",
          variableType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "x::number",
      expected: { success: false },
    },
    {
      input: "bar number",
      expected: { success: false },
    },
    {
      input: ":: number",
      expected: { success: false },
    },
    {
      input: "bar ::",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = typeHintParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = typeHintParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
