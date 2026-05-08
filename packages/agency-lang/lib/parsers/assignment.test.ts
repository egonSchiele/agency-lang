import { describe, it, expect } from "vitest";
import { assignmentParser, modifiedAssignmentParser } from "./parsers.js";

describe("assignmentParser", () => {
  const testCases = [
    // Happy path - simple literal assignments
    {
      input: "x = 5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          value: { type: "number", value: "5" },
        },
      },
    },
    {
      input: 'name = "Alice"',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "name",
          value: {
            type: "string",
            segments: [{ type: "text", value: "Alice" }],
          },
        },
      },
    },
    {
      input: "bar = `the number 1`",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "bar",
          value: {
            type: "string",
            segments: [{ type: "text", value: "the number 1" }],
          },
        },
      },
    },
    {
      input: "result = someVariable",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "result",
          value: { type: "variableName", value: "someVariable" },
        },
      },
    },

    // With optional semicolon
    {
      input: "x = 42;",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          value: { type: "number", value: "42" },
        },
      },
    },

    // With optional spaces
    {
      input: "  x  =  5  ",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          value: { type: "number", value: "5" },
        },
      },
    },
    {
      input: "x=5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          value: { type: "number", value: "5" },
        },
      },
    },

    // Variable names with underscores and numbers
    {
      input: "my_var_123 = 999",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "my_var_123",
          value: { type: "number", value: "999" },
        },
      },
    },
    {
      input: "_privateVar = true",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "_privateVar",
          value: { type: "boolean", value: true },
        },
      },
    },

    // Function call assignment
    {
      input: "result = foo()",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "result",
          value: {
            type: "functionCall",
            functionName: "foo",
            arguments: [],
          },
        },
      },
    },
    {
      input: 'output = calculate(1, "test")',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "output",
          value: {
            type: "functionCall",
            functionName: "calculate",
            arguments: [
              { type: "number", value: "1" },
              {
                type: "string",
                segments: [{ type: "text", value: "test" }],
              },
            ],
          },
        },
      },
    },

    // Array assignment
    {
      input: "arr = [1, 2, 3]",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "arr",
          value: {
            type: "agencyArray",
            items: [
              { type: "number", value: "1" },
              { type: "number", value: "2" },
              { type: "number", value: "3" },
            ],
          },
        },
      },
    },
    {
      input: "empty = []",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "empty",
          value: {
            type: "agencyArray",
            items: [],
          },
        },
      },
    },

    // Object assignment
    {
      input: 'obj = { key: "value" }',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "obj",
          value: {
            type: "agencyObject",
            entries: [
              {
                key: "key",
                value: {
                  type: "string",
                  segments: [{ type: "text", value: "value" }],
                },
              },
            ],
          },
        },
      },
    },
    {
      input: "emptyObj = {}",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "emptyObj",
          value: {
            type: "agencyObject",
            entries: [],
          },
        },
      },
    },

    // Access expression assignment
    {
      input: "value = obj.property",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "value",
          value: {
            type: "valueAccess",
            base: { type: "variableName", value: "obj" },
            chain: [{ kind: "property", name: "property" }],
          },
        },
      },
    },

    // Negative numbers
    {
      input: "negative = -42",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "negative",
          value: { type: "number", value: "-42" },
        },
      },
    },

    // Decimal numbers
    {
      input: "pi = 3.14",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "pi",
          value: { type: "number", value: "3.14" },
        },
      },
    },

    // Typed assignments - primitive types
    {
      input: "foo: number = 1",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "foo",
          typeHint: { type: "primitiveType", value: "number" },
          value: { type: "number", value: "1" },
        },
      },
    },
    {
      input: "bar: number = `the number 1`",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "bar",
          typeHint: { type: "primitiveType", value: "number" },
          value: {
            type: "string",
            segments: [{ type: "text", value: "the number 1" }],
          },
        },
      },
    },
    {
      input: 'name: string = "Alice"',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "name",
          typeHint: { type: "primitiveType", value: "string" },
          value: {
            type: "string",
            segments: [{ type: "text", value: "Alice" }],
          },
        },
      },
    },
    {
      input: "isActive: boolean = true",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "isActive",
          typeHint: { type: "primitiveType", value: "boolean" },
          value: { type: "boolean", value: true },
        },
      },
    },

    // Typed assignments - array types
    {
      input: "items: number[] = [1, 2, 3]",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "items",
          typeHint: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          value: {
            type: "agencyArray",
            items: [
              { type: "number", value: "1" },
              { type: "number", value: "2" },
              { type: "number", value: "3" },
            ],
          },
        },
      },
    },
    {
      input: 'names: string[] = ["Alice", "Bob"]',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "names",
          typeHint: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "string" },
          },
          value: {
            type: "agencyArray",
            items: [
              {
                type: "string",
                segments: [{ type: "text", value: "Alice" }],
              },
              {
                type: "string",
                segments: [{ type: "text", value: "Bob" }],
              },
            ],
          },
        },
      },
    },

    // Typed assignments - with whitespace variations
    {
      input: "x:number=5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "x",
          typeHint: { type: "primitiveType", value: "number" },
          value: { type: "number", value: "5" },
        },
      },
    },
    {
      input: "  y  :  string  =  `hello`  ",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "y",
          typeHint: { type: "primitiveType", value: "string" },
          value: {
            type: "string",
            segments: [{ type: "text", value: "hello" }],
          },
        },
      },
    },

    // Typed assignments - with semicolons
    {
      input: "count: number = 42;",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "count",
          typeHint: { type: "primitiveType", value: "number" },
          value: { type: "number", value: "42" },
        },
      },
    },

    // Property assignment
    {
      input: 'user.name = "Bob"',
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "user",
          accessChain: [{ kind: "property", name: "name" }],
          value: {
            type: "string",
            segments: [{ type: "text", value: "Bob" }],
          },
        },
      },
    },

    // Index assignment
    {
      input: "arr[0] = 5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "arr",
          accessChain: [{ kind: "index", index: { type: "number", value: "0" } }],
          value: { type: "number", value: "5" },
        },
      },
    },

    // Nested property assignment
    {
      input: "obj.nested.prop = true",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "obj",
          accessChain: [
            { kind: "property", name: "nested" },
            { kind: "property", name: "prop" },
          ],
          value: { type: "boolean", value: true },
        },
      },
    },

    // let/const declarations
    {
      input: "let x = 5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          declKind: "let",
          variableName: "x",
          value: { type: "number", value: "5" },
        },
      },
    },
    {
      input: "const y = 5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          declKind: "const",
          variableName: "y",
          value: { type: "number", value: "5" },
        },
      },
    },
    {
      input: 'let name: string = "Alice"',
      expected: {
        success: true,
        result: {
          type: "assignment",
          declKind: "let",
          variableName: "name",
          typeHint: { type: "primitiveType", value: "string" },
          value: {
            type: "string",
            segments: [{ type: "text", value: "Alice" }],
          },
        },
      },
    },
    {
      input: "const items: number[] = [1, 2, 3]",
      expected: {
        success: true,
        result: {
          type: "assignment",
          declKind: "const",
          variableName: "items",
          typeHint: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          value: {
            type: "agencyArray",
            items: [
              { type: "number", value: "1" },
              { type: "number", value: "2" },
              { type: "number", value: "3" },
            ],
          },
        },
      },
    },

    // Variable names starting with let/const should not be misinterpreted
    {
      input: "letter = 5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "letter",
          value: { type: "number", value: "5" },
        },
      },
    },
    {
      input: "constant = 5",
      expected: {
        success: true,
        result: {
          type: "assignment",
          variableName: "constant",
          value: { type: "number", value: "5" },
        },
      },
    },

    // let/const with access chains should fail
    { input: "let obj.x = 1", expected: { success: false } },
    { input: "const arr[0] = 5", expected: { success: false } },

    // Failure cases
    { input: "=5", expected: { success: false } },
    { input: "x =", expected: { success: false } },
    { input: "", expected: { success: false } },
    { input: "x", expected: { success: false } },
    { input: "x ==5", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = assignmentParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
          const result = assignmentParser(input);
          expect(result.success).toBe(false);
        });
    }
  });
});

describe("modifiedAssignmentParser", () => {
  it("should parse static const with a number", () => {
    const result = modifiedAssignmentParser("static const x = 42");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("assignment");
      expect(result.result.variableName).toBe("x");
      expect(result.result.static).toBe(true);
      expect(result.result.declKind).toBe("const");
      expect(result.result.value).toEqualWithoutLoc({ type: "number", value: "42" });
    }
  });

  it("should parse static const with a string", () => {
    const result = modifiedAssignmentParser('static const name = "Alice"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.static).toBe(true);
      expect(result.result.declKind).toBe("const");
      expect(result.result.variableName).toBe("name");
    }
  });

  it("should parse static const with a function call", () => {
    const result = modifiedAssignmentParser('static const myPrompt = read("prompt.md")');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.static).toBe(true);
      expect(result.result.declKind).toBe("const");
      expect(result.result.variableName).toBe("myPrompt");
      expect(result.result.value.type).toBe("functionCall");
    }
  });

  it("should reject static let", () => {
    const result = modifiedAssignmentParser("static let x = 42");
    expect(result.success).toBe(false);
  });

  it("should reject static without const", () => {
    const result = modifiedAssignmentParser("static x = 42");
    expect(result.success).toBe(false);
  });

  it("should not parse a regular assignment", () => {
    const result = modifiedAssignmentParser("x = 42");
    expect(result.success).toBe(false);
  });

  it("should not parse const without static", () => {
    const result = modifiedAssignmentParser("const x = 42");
    expect(result.success).toBe(false);
  });

  it("regular assignmentParser should not set static", () => {
    const result = assignmentParser("x = 42");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.static).toBeUndefined();
    }
  });

  it("parses assignment with validated type annotation", () => {
    const result = assignmentParser("const x: number! = foo");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.typeHint).toEqual({ type: "primitiveType", value: "number" });
      expect(result.result.validated).toBe(true);
    }
  });

  it("parses assignment with validated union type", () => {
    const result = assignmentParser('const x: "happy"|"sad"! = foo');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.typeHint?.type).toBe("unionType");
      expect(result.result.validated).toBe(true);
    }
  });

  it("parses assignment without ! as not validated", () => {
    const result = assignmentParser("const x: number = foo");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.validated).toBeUndefined();
    }
  });
});
