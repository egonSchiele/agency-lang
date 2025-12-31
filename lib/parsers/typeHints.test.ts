import { describe, it, expect } from "vitest";
import {
  primitiveTypeParser,
  arrayTypeParser,
  angleBracketsArrayTypeParser,
  stringLiteralTypeParser,
  numberLiteralTypeParser,
  booleanLiteralTypeParser,
  objectPropertyParser,
  objectPropertyDescriptionParser,
  objectPropertyWithDescriptionParser,
  objectTypeParser,
  typeAliasParser,
  typeAliasVariableParser,
  variableTypeParser,
  unionTypeParser,
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

describe("typeAliasParser", () => {
  const testCases = [
    // Basic type aliases with primitives
    {
      input: "type Name = string",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Name",
          aliasedType: { type: "primitiveType", value: "string" },
        },
      },
    },
    {
      input: "type Count = number",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Count",
          aliasedType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "type Flag = boolean",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Flag",
          aliasedType: { type: "primitiveType", value: "boolean" },
        },
      },
    },
    // Object type aliases
    {
      input: "type Point = { x: number; y: number }",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Point",
          aliasedType: {
            type: "objectType",
            properties: [
              {
                key: "x",
                value: { type: "primitiveType", value: "number" },
              },
              {
                key: "y",
                value: { type: "primitiveType", value: "number" },
              },
            ],
          },
        },
      },
    },
    {
      input: "type User = { name: string; age: number; active: boolean }",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "User",
          aliasedType: {
            type: "objectType",
            properties: [
              {
                key: "name",
                value: { type: "primitiveType", value: "string" },
              },
              {
                key: "age",
                value: { type: "primitiveType", value: "number" },
              },
              {
                key: "active",
                value: { type: "primitiveType", value: "boolean" },
              },
            ],
          },
        },
      },
    },
    // Array type aliases
    {
      input: "type Numbers = number[]",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Numbers",
          aliasedType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
        },
      },
    },
    {
      input: "type Items = array<string>",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Items",
          aliasedType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "string" },
          },
        },
      },
    },
    // Literal type aliases
    {
      input: 'type Status = "active"',
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Status",
          aliasedType: { type: "stringLiteralType", value: "active" },
        },
      },
    },
    {
      input: "type Level = 42",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Level",
          aliasedType: { type: "numberLiteralType", value: "42" },
        },
      },
    },
    {
      input: "type Enabled = true",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Enabled",
          aliasedType: { type: "booleanLiteralType", value: "true" },
        },
      },
    },
    // Union type aliases
    {
      input: "type StringOrNumber = string | number",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "StringOrNumber",
          aliasedType: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "number" },
            ],
          },
        },
      },
    },
    {
      input: 'type Result = "success" | "error"',
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Result",
          aliasedType: {
            type: "unionType",
            types: [
              { type: "stringLiteralType", value: "success" },
              { type: "stringLiteralType", value: "error" },
            ],
          },
        },
      },
    },
    {
      input: "type Mixed = string | 42 | true",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Mixed",
          aliasedType: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "numberLiteralType", value: "42" },
              { type: "booleanLiteralType", value: "true" },
            ],
          },
        },
      },
    },
    // Nested/Complex type aliases
    {
      input: "type Nested = { coords: { x: number; y: number } }",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Nested",
          aliasedType: {
            type: "objectType",
            properties: [
              {
                key: "coords",
                value: {
                  type: "objectType",
                  properties: [
                    {
                      key: "x",
                      value: { type: "primitiveType", value: "number" },
                    },
                    {
                      key: "y",
                      value: { type: "primitiveType", value: "number" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
    {
      input: "type Complex = { value: string | number }",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "Complex",
          aliasedType: {
            type: "objectType",
            properties: [
              {
                key: "value",
                value: {
                  type: "unionType",
                  types: [
                    { type: "primitiveType", value: "string" },
                    { type: "primitiveType", value: "number" },
                  ],
                },
              },
            ],
          },
        },
      },
    },
    // Whitespace variations
    {
      input: "type A=number",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "A",
          aliasedType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "type B = number",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "B",
          aliasedType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "type C  =  number",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "C",
          aliasedType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "type D = number[]",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "D",
          aliasedType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
        },
      },
    },
    // Different naming styles
    {
      input: "type MyType = string",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "MyType",
          aliasedType: { type: "primitiveType", value: "string" },
        },
      },
    },
    {
      input: "type x = number",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "x",
          aliasedType: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "type ABC = boolean",
      expected: {
        success: true,
        result: {
          type: "typeAlias",
          aliasName: "ABC",
          aliasedType: { type: "primitiveType", value: "boolean" },
        },
      },
    },
    // Failure cases
    {
      input: "type",
      expected: { success: false },
    },
    {
      input: "type A",
      expected: { success: false },
    },
    {
      input: "type A =",
      expected: { success: false },
    },
    {
      input: "type = number",
      expected: { success: false },
    },
    {
      input: "A = number",
      expected: { success: false },
    },
    {
      input: "type A number",
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
        const result = typeAliasParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = typeAliasParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("typeAliasVariableParser", () => {
  const testCases = [
    // Simple references
    {
      input: "Point",
      expected: {
        success: true,
        result: {
          type: "typeAliasVariable",
          aliasName: "Point",
        },
      },
    },
    {
      input: "MyType",
      expected: {
        success: true,
        result: {
          type: "typeAliasVariable",
          aliasName: "MyType",
        },
      },
    },
    {
      input: "UserData",
      expected: {
        success: true,
        result: {
          type: "typeAliasVariable",
          aliasName: "UserData",
        },
      },
    },
    {
      input: "x",
      expected: {
        success: true,
        result: {
          type: "typeAliasVariable",
          aliasName: "x",
        },
      },
    },
    // Edge cases
    {
      input: "a123",
      expected: {
        success: true,
        result: {
          type: "typeAliasVariable",
          aliasName: "a123",
        },
      },
    },
    {
      input: "ABC",
      expected: {
        success: true,
        result: {
          type: "typeAliasVariable",
          aliasName: "ABC",
        },
      },
    },
    {
      input: "longtypename",
      expected: {
        success: true,
        result: {
          type: "typeAliasVariable",
          aliasName: "longtypename",
        },
      },
    },
    // Failure cases
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = typeAliasVariableParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = typeAliasVariableParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("objectPropertyParser", () => {
  const testCases = [
    {
      input: "x: number",
      expected: {
        success: true,
        result: {
          key: "x",
          value: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "name: string",
      expected: {
        success: true,
        result: {
          key: "name",
          value: { type: "primitiveType", value: "string" },
        },
      },
    },
    {
      input: "active: boolean",
      expected: {
        success: true,
        result: {
          key: "active",
          value: { type: "primitiveType", value: "boolean" },
        },
      },
    },
    {
      input: "items: number[]",
      expected: {
        success: true,
        result: {
          key: "items",
          value: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
        },
      },
    },
    {
      input: 'status: "active"',
      expected: {
        success: true,
        result: {
          key: "status",
          value: { type: "stringLiteralType", value: "active" },
        },
      },
    },
    {
      input: "count: 42",
      expected: {
        success: true,
        result: {
          key: "count",
          value: { type: "numberLiteralType", value: "42" },
        },
      },
    },
    {
      input: "x:number",
      expected: {
        success: true,
        result: {
          key: "x",
          value: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "x  :  number",
      expected: {
        success: true,
        result: {
          key: "x",
          value: { type: "primitiveType", value: "number" },
        },
      },
    },
    {
      input: "x number",
      expected: { success: false },
    },
    {
      input: "x:",
      expected: { success: false },
    },
    {
      input: ": number",
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
        const result = objectPropertyParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = objectPropertyParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("objectPropertyDescriptionParser", () => {
  const testCases = [
    {
      input: "# this is a description;",
      expected: {
        success: true,
        result: {
          description: "this is a description",
        },
      },
    },
    {
      input: "# hostname of a url;",
      expected: {
        success: true,
        result: {
          description: "hostname of a url",
        },
      },
    },
    {
      input: "#simple;",
      expected: {
        success: true,
        result: {
          description: "simple",
        },
      },
    },
    {
      input: "#  with extra spaces  ;",
      expected: {
        success: true,
        result: {
          description: "with extra spaces  ",
        },
      },
    },
    {
      input: "# description with, punctuation!;",
      expected: {
        success: true,
        result: {
          description: "description with, punctuation!",
        },
      },
    },
    {
      input: "# description with numbers 123;",
      expected: {
        success: true,
        result: {
          description: "description with numbers 123",
        },
      },
    },
    // Failure cases
    {
      input: "no hash;",
      expected: { success: false },
    },
    {
      input: "#;",
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
        const result = objectPropertyDescriptionParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = objectPropertyDescriptionParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("objectPropertyWithDescriptionParser", () => {
  const testCases = [
    {
      input: "hostname: string # hostname of a url;",
      expected: {
        success: true,
        result: {
          key: "hostname",
          value: { type: "primitiveType", value: "string" },
          description: "hostname of a url",
        },
      },
    },
    {
      input: "x: number # x coordinate;",
      expected: {
        success: true,
        result: {
          key: "x",
          value: { type: "primitiveType", value: "number" },
          description: "x coordinate",
        },
      },
    },
    {
      input: "active: boolean # whether user is active;",
      expected: {
        success: true,
        result: {
          key: "active",
          value: { type: "primitiveType", value: "boolean" },
          description: "whether user is active",
        },
      },
    },
    {
      input: "items: number[] # list of item ids;",
      expected: {
        success: true,
        result: {
          key: "items",
          value: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          description: "list of item ids",
        },
      },
    },
    {
      input: 'status: "active" # current status;',
      expected: {
        success: true,
        result: {
          key: "status",
          value: { type: "stringLiteralType", value: "active" },
          description: "current status",
        },
      },
    },
    {
      input: "count: 42 # default count;",
      expected: {
        success: true,
        result: {
          key: "count",
          value: { type: "numberLiteralType", value: "42" },
          description: "default count",
        },
      },
    },
    // Without extra spaces
    {
      input: "name: string #user name;",
      expected: {
        success: true,
        result: {
          key: "name",
          value: { type: "primitiveType", value: "string" },
          description: "user name",
        },
      },
    },
    // Failure cases
    {
      input: "x: number",
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
        const result = objectPropertyWithDescriptionParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = objectPropertyWithDescriptionParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("objectTypeParser", () => {
  const testCases = [
    // Single property
    {
      input: "{ x: number }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "x",
              value: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    // Multiple properties
    {
      input: "{ x: number; y: number }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "x",
              value: { type: "primitiveType", value: "number" },
            },
            {
              key: "y",
              value: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    {
      input: "{ name: string; age: number; active: boolean }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "name",
              value: { type: "primitiveType", value: "string" },
            },
            {
              key: "age",
              value: { type: "primitiveType", value: "number" },
            },
            {
              key: "active",
              value: { type: "primitiveType", value: "boolean" },
            },
          ],
        },
      },
    },
    // With different value types
    {
      input: "{ items: number[]; tags: string[] }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "items",
              value: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "number" },
              },
            },
            {
              key: "tags",
              value: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "string" },
              },
            },
          ],
        },
      },
    },
    {
      input: '{ status: "active"; count: 42 }',
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "status",
              value: { type: "stringLiteralType", value: "active" },
            },
            {
              key: "count",
              value: { type: "numberLiteralType", value: "42" },
            },
          ],
        },
      },
    },
    // Whitespace variations
    {
      input: "{x:number}",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "x",
              value: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    {
      input: "{  x: number  }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "x",
              value: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    {
      input: "{ x: number ; y: number }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "x",
              value: { type: "primitiveType", value: "number" },
            },
            {
              key: "y",
              value: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    // Empty object
    {
      input: "{}",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [],
        },
      },
    },
    {
      input: "{  }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [],
        },
      },
    },
    // Object with union type values
    {
      input: "{ value: string | number }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "value",
              value: {
                type: "unionType",
                types: [
                  { type: "primitiveType", value: "string" },
                  { type: "primitiveType", value: "number" },
                ],
              },
            },
          ],
        },
      },
    },
    {
      input: '{ status: "active" | "inactive"; count: number }',
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "status",
              value: {
                type: "unionType",
                types: [
                  { type: "stringLiteralType", value: "active" },
                  { type: "stringLiteralType", value: "inactive" },
                ],
              },
            },
            {
              key: "count",
              value: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    {
      input: "{ data: string | number | boolean }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "data",
              value: {
                type: "unionType",
                types: [
                  { type: "primitiveType", value: "string" },
                  { type: "primitiveType", value: "number" },
                  { type: "primitiveType", value: "boolean" },
                ],
              },
            },
          ],
        },
      },
    },
    // Nested object types
    {
      input: "{ coords: { x: number; y: number } }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "coords",
              value: {
                type: "objectType",
                properties: [
                  {
                    key: "x",
                    value: { type: "primitiveType", value: "number" },
                  },
                  {
                    key: "y",
                    value: { type: "primitiveType", value: "number" },
                  },
                ],
              },
            },
          ],
        },
      },
    },
    {
      input: "{ user: { name: string; age: number }; active: boolean }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "user",
              value: {
                type: "objectType",
                properties: [
                  {
                    key: "name",
                    value: { type: "primitiveType", value: "string" },
                  },
                  {
                    key: "age",
                    value: { type: "primitiveType", value: "number" },
                  },
                ],
              },
            },
            {
              key: "active",
              value: { type: "primitiveType", value: "boolean" },
            },
          ],
        },
      },
    },
    {
      input: "{ outer: { inner: { value: string } } }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "outer",
              value: {
                type: "objectType",
                properties: [
                  {
                    key: "inner",
                    value: {
                      type: "objectType",
                      properties: [
                        {
                          key: "value",
                          value: { type: "primitiveType", value: "string" },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
    // Object with type alias properties
    {
      input: "{ coord: Point }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "coord",
              value: {
                type: "typeAliasVariable",
                aliasName: "Point",
              },
            },
          ],
        },
      },
    },
    {
      input: "{ start: Point; end: Point }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "start",
              value: {
                type: "typeAliasVariable",
                aliasName: "Point",
              },
            },
            {
              key: "end",
              value: {
                type: "typeAliasVariable",
                aliasName: "Point",
              },
            },
          ],
        },
      },
    },
    {
      input: "{ data: Point | Line }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "data",
              value: {
                type: "unionType",
                types: [
                  {
                    type: "typeAliasVariable",
                    aliasName: "Point",
                  },
                  {
                    type: "typeAliasVariable",
                    aliasName: "Line",
                  },
                ],
              },
            },
          ],
        },
      },
    },
    // Failure cases
    {
      input: "{ x number }",
      expected: { success: false },
    },
    {
      input: "{ x: }",
      expected: { success: false },
    },
    {
      input: "{ : number }",
      expected: { success: false },
    },
    {
      input: "{ x: number",
      expected: { success: false },
    },
    {
      input: "x: number }",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
    // With descriptions
    {
      input: "{ hostname: string # hostname of a url; }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "hostname",
              value: { type: "primitiveType", value: "string" },
              description: "hostname of a url",
            },
          ],
        },
      },
    },
    {
      input: "{ x: number # x coordinate; y: number # y coordinate; }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "x",
              value: { type: "primitiveType", value: "number" },
              description: "x coordinate",
            },
            {
              key: "y",
              value: { type: "primitiveType", value: "number" },
              description: "y coordinate",
            },
          ],
        },
      },
    },
    {
      input: "{ name: string # user name; age: number; active: boolean # is active; }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "name",
              value: { type: "primitiveType", value: "string" },
              description: "user name",
            },
            {
              key: "age",
              value: { type: "primitiveType", value: "number" },
            },
            {
              key: "active",
              value: { type: "primitiveType", value: "boolean" },
              description: "is active",
            },
          ],
        },
      },
    },
    {
      input: "{ items: number[] # list of ids; }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "items",
              value: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "number" },
              },
              description: "list of ids",
            },
          ],
        },
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = objectTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = objectTypeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("unionTypeParser", () => {
  const testCases = [
    // Basic union types
    {
      input: "string | number",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "primitiveType", value: "string" },
            { type: "primitiveType", value: "number" },
          ],
        },
      },
    },
    {
      input: "number | string",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "primitiveType", value: "number" },
            { type: "primitiveType", value: "string" },
          ],
        },
      },
    },
    {
      input: "string | boolean",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "primitiveType", value: "string" },
            { type: "primitiveType", value: "boolean" },
          ],
        },
      },
    },
    // Union with literal types
    {
      input: '"hello" | "world"',
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "stringLiteralType", value: "hello" },
            { type: "stringLiteralType", value: "world" },
          ],
        },
      },
    },
    {
      input: "42 | 100",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "numberLiteralType", value: "42" },
            { type: "numberLiteralType", value: "100" },
          ],
        },
      },
    },
    {
      input: "true | false",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "booleanLiteralType", value: "true" },
            { type: "booleanLiteralType", value: "false" },
          ],
        },
      },
    },
    // Mixed literals and primitives
    {
      input: '"hello" | number',
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "stringLiteralType", value: "hello" },
            { type: "primitiveType", value: "number" },
          ],
        },
      },
    },
    {
      input: '42 | string',
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "numberLiteralType", value: "42" },
            { type: "primitiveType", value: "string" },
          ],
        },
      },
    },
    // Multiple types (more than 2)
    {
      input: "string | number | boolean",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "primitiveType", value: "string" },
            { type: "primitiveType", value: "number" },
            { type: "primitiveType", value: "boolean" },
          ],
        },
      },
    },
    {
      input: '"a" | "b" | "c"',
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "stringLiteralType", value: "a" },
            { type: "stringLiteralType", value: "b" },
            { type: "stringLiteralType", value: "c" },
          ],
        },
      },
    },
    // Whitespace variations
    {
      input: "string|number",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "primitiveType", value: "string" },
            { type: "primitiveType", value: "number" },
          ],
        },
      },
    },
    {
      input: "string  |  number",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "primitiveType", value: "string" },
            { type: "primitiveType", value: "number" },
          ],
        },
      },
    },
    // Union with array types
    {
      input: "string[] | number[]",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "string" },
            },
            {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    {
      input: "array<string> | array<number>",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "string" },
            },
            {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    // Union of object types
    {
      input: "{ x: number } | { y: string }",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "objectType",
              properties: [
                {
                  key: "x",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
            {
              type: "objectType",
              properties: [
                {
                  key: "y",
                  value: { type: "primitiveType", value: "string" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "{ name: string; age: number } | { id: number; active: boolean }",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "objectType",
              properties: [
                {
                  key: "name",
                  value: { type: "primitiveType", value: "string" },
                },
                {
                  key: "age",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
            {
              type: "objectType",
              properties: [
                {
                  key: "id",
                  value: { type: "primitiveType", value: "number" },
                },
                {
                  key: "active",
                  value: { type: "primitiveType", value: "boolean" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "{ x: number } | { y: number } | { z: number }",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "objectType",
              properties: [
                {
                  key: "x",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
            {
              type: "objectType",
              properties: [
                {
                  key: "y",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
            {
              type: "objectType",
              properties: [
                {
                  key: "z",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
          ],
        },
      },
    },
    // Union of objects with union properties
    {
      input: '{ status: "active" | "inactive" } | { code: number }',
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "objectType",
              properties: [
                {
                  key: "status",
                  value: {
                    type: "unionType",
                    types: [
                      { type: "stringLiteralType", value: "active" },
                      { type: "stringLiteralType", value: "inactive" },
                    ],
                  },
                },
              ],
            },
            {
              type: "objectType",
              properties: [
                {
                  key: "code",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "{ value: string | number } | { data: boolean | number }",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "objectType",
              properties: [
                {
                  key: "value",
                  value: {
                    type: "unionType",
                    types: [
                      { type: "primitiveType", value: "string" },
                      { type: "primitiveType", value: "number" },
                    ],
                  },
                },
              ],
            },
            {
              type: "objectType",
              properties: [
                {
                  key: "data",
                  value: {
                    type: "unionType",
                    types: [
                      { type: "primitiveType", value: "boolean" },
                      { type: "primitiveType", value: "number" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: '{ type: "user"; name: string } | { type: "admin"; level: number }',
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "objectType",
              properties: [
                {
                  key: "type",
                  value: { type: "stringLiteralType", value: "user" },
                },
                {
                  key: "name",
                  value: { type: "primitiveType", value: "string" },
                },
              ],
            },
            {
              type: "objectType",
              properties: [
                {
                  key: "type",
                  value: { type: "stringLiteralType", value: "admin" },
                },
                {
                  key: "level",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
          ],
        },
      },
    },
    // Union with type aliases
    {
      input: "Point | Line",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "typeAliasVariable",
              aliasName: "Point",
            },
            {
              type: "typeAliasVariable",
              aliasName: "Line",
            },
          ],
        },
      },
    },
    {
      input: "string | Point",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            { type: "primitiveType", value: "string" },
            {
              type: "typeAliasVariable",
              aliasName: "Point",
            },
          ],
        },
      },
    },
    {
      input: "Point | { x: number }",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "typeAliasVariable",
              aliasName: "Point",
            },
            {
              type: "objectType",
              properties: [
                {
                  key: "x",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
          ],
        },
      },
    },
    {
      input: "Point | Line | Circle",
      expected: {
        success: true,
        result: {
          type: "unionType",
          types: [
            {
              type: "typeAliasVariable",
              aliasName: "Point",
            },
            {
              type: "typeAliasVariable",
              aliasName: "Line",
            },
            {
              type: "typeAliasVariable",
              aliasName: "Circle",
            },
          ],
        },
      },
    },
    // Failure cases
    {
      input: "string",
      expected: { success: false },
    },
    {
      input: "string number",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
    {
      input: "|",
      expected: { success: false },
    },
    {
      input: "string |",
      expected: { success: false },
    },
    {
      input: "| string",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = unionTypeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = unionTypeParser(input);
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
      input: "{ x: number }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "x",
              value: { type: "primitiveType", value: "number" },
            },
          ],
        },
      },
    },
    {
      input: "{ x: number; y: string }",
      expected: {
        success: true,
        result: {
          type: "objectType",
          properties: [
            {
              key: "x",
              value: { type: "primitiveType", value: "number" },
            },
            {
              key: "y",
              value: { type: "primitiveType", value: "string" },
            },
          ],
        },
      },
    },
    // Type alias references
    {
      input: "Point",
      expected: {
        success: true,
        result: {
          type: "typeAliasVariable",
          aliasName: "Point",
        },
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
    // Union types
    {
      input: "foo :: string | number",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "foo",
          variableType: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "number" },
            ],
          },
        },
      },
    },
    {
      input: "value :: number | string | boolean",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "value",
          variableType: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "number" },
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "boolean" },
            ],
          },
        },
      },
    },
    {
      input: 'status :: "success" | "error"',
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "status",
          variableType: {
            type: "unionType",
            types: [
              { type: "stringLiteralType", value: "success" },
              { type: "stringLiteralType", value: "error" },
            ],
          },
        },
      },
    },
    {
      input: "mixed :: 42 | string",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "mixed",
          variableType: {
            type: "unionType",
            types: [
              { type: "numberLiteralType", value: "42" },
              { type: "primitiveType", value: "string" },
            ],
          },
        },
      },
    },
    {
      input: "arrays :: string[] | number[]",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "arrays",
          variableType: {
            type: "unionType",
            types: [
              {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "string" },
              },
              {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "number" },
              },
            ],
          },
        },
      },
    },
    // Object types
    {
      input: "point :: { x: number; y: number }",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "point",
          variableType: {
            type: "objectType",
            properties: [
              {
                key: "x",
                value: { type: "primitiveType", value: "number" },
              },
              {
                key: "y",
                value: { type: "primitiveType", value: "number" },
              },
            ],
          },
        },
      },
    },
    {
      input: "user :: { name: string; age: number; active: boolean }",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "user",
          variableType: {
            type: "objectType",
            properties: [
              {
                key: "name",
                value: { type: "primitiveType", value: "string" },
              },
              {
                key: "age",
                value: { type: "primitiveType", value: "number" },
              },
              {
                key: "active",
                value: { type: "primitiveType", value: "boolean" },
              },
            ],
          },
        },
      },
    },
    {
      input: "coords :: { items: number[]; tags: string[] }",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "coords",
          variableType: {
            type: "objectType",
            properties: [
              {
                key: "items",
                value: {
                  type: "arrayType",
                  elementType: { type: "primitiveType", value: "number" },
                },
              },
              {
                key: "tags",
                value: {
                  type: "arrayType",
                  elementType: { type: "primitiveType", value: "string" },
                },
              },
            ],
          },
        },
      },
    },
    // Type alias types
    {
      input: "coords :: Point",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "coords",
          variableType: {
            type: "typeAliasVariable",
            aliasName: "Point",
          },
        },
      },
    },
    {
      input: "data :: Point | Line",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "data",
          variableType: {
            type: "unionType",
            types: [
              {
                type: "typeAliasVariable",
                aliasName: "Point",
              },
              {
                type: "typeAliasVariable",
                aliasName: "Line",
              },
            ],
          },
        },
      },
    },
    {
      input: "nested :: { coord: Point }",
      expected: {
        success: true,
        result: {
          type: "typeHint",
          variableName: "nested",
          variableType: {
            type: "objectType",
            properties: [
              {
                key: "coord",
                value: {
                  type: "typeAliasVariable",
                  aliasName: "Point",
                },
              },
            ],
          },
        },
      },
    },
    // Failure cases
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
