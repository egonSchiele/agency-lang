import { describe, it, expect } from "vitest";
import { TypeChecker, typeCheck } from "./typeChecker.js";
import { AgencyProgram } from "./types.js";

describe("TypeChecker", () => {
  describe("function call argument type matching", () => {
    it("should pass with correct argument types", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "myName",
            typeHint: { type: "primitiveType", value: "string" },
            value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [{ type: "variableName", value: "myName" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should error with mismatched argument types", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "age",
            typeHint: { type: "primitiveType", value: "number" },
            value: { type: "number", value: "42" },
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [{ type: "variableName", value: "age" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
      expect(errors[0].expectedType).toBe("string");
      expect(errors[0].actualType).toBe("number");
    });

    it("should error with wrong number of arguments", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "add",
            parameters: [
              {
                type: "functionParameter",
                name: "a",
                typeHint: { type: "primitiveType", value: "number" },
              },
              {
                type: "functionParameter",
                name: "b",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "add",
            arguments: [{ type: "number", value: "1" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Expected 2 argument(s)");
      expect(errors[0].message).toContain("but got 1");
    });
  });

  describe("strict mode", () => {
    it("should not error for untyped variables in non-strict mode", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should error for untyped variables in strict mode", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" },
          },
        ],
      };

      const { errors } = typeCheck(program, { strictTypes: true });
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("no type annotation");
      expect(errors[0].message).toContain("strict mode");
      expect(errors[0].variableName).toBe("x");
    });
  });

  describe("type alias resolution", () => {
    it("should resolve type aliases in function parameters", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "Name",
            aliasedType: { type: "primitiveType", value: "string" },
          },
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "typeAliasVariable", aliasName: "Name" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "myName",
            typeHint: { type: "primitiveType", value: "string" },
            value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [{ type: "variableName", value: "myName" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should error on undefined type alias", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "Foo",
            aliasedType: { type: "typeAliasVariable", aliasName: "Bar" },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Type alias 'Bar' is not defined");
    });
  });

  describe("union type compatibility", () => {
    it("should allow string literal assignable to union", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "process",
            parameters: [
              {
                type: "functionParameter",
                name: "status",
                typeHint: {
                  type: "unionType",
                  types: [
                    { type: "stringLiteralType", value: "success" },
                    { type: "stringLiteralType", value: "error" },
                  ],
                },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "s",
            typeHint: { type: "stringLiteralType", value: "success" },
            value: {
              type: "prompt",
              segments: [{ type: "text", value: "Pick a status" }],
            },
          },
          {
            type: "functionCall",
            functionName: "process",
            arguments: [{ type: "variableName", value: "s" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should error when value not in union", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "process",
            parameters: [
              {
                type: "functionParameter",
                name: "status",
                typeHint: {
                  type: "unionType",
                  types: [
                    { type: "stringLiteralType", value: "success" },
                    { type: "stringLiteralType", value: "error" },
                  ],
                },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "n",
            typeHint: { type: "primitiveType", value: "number" },
            value: { type: "number", value: "42" },
          },
          {
            type: "functionCall",
            functionName: "process",
            arguments: [{ type: "variableName", value: "n" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
    });
  });

  describe("return type checking", () => {
    it("should pass when return type matches", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "getName",
            parameters: [],
            returnType: { type: "primitiveType", value: "string" },
            body: [
              {
                type: "returnStatement",
                value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should error when return type mismatches", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "getName",
            parameters: [],
            returnType: { type: "primitiveType", value: "string" },
            body: [
              {
                type: "returnStatement",
                value: { type: "number", value: "42" },
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to type");
    });

    it("should skip prompt in return type check (prompts adopt expected type)", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "askName",
            parameters: [],
            returnType: {
              type: "objectType",
              properties: [{ key: "name", value: { type: "primitiveType", value: "string" } }],
            },
            body: [
              {
                type: "returnStatement",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "What is your name?" }],
                },
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });
  });

  describe("literal type assignable to base primitive", () => {
    it("should allow string literal assignable to string", () => {
      const checker = new TypeChecker(
        { type: "agencyProgram", nodes: [] },
      );
      checker.check();

      expect(
        checker.isAssignable(
          { type: "stringLiteralType", value: "hello" },
          { type: "primitiveType", value: "string" },
        ),
      ).toBe(true);
    });

    it("should allow number literal assignable to number", () => {
      const checker = new TypeChecker(
        { type: "agencyProgram", nodes: [] },
      );
      checker.check();

      expect(
        checker.isAssignable(
          { type: "numberLiteralType", value: "42" },
          { type: "primitiveType", value: "number" },
        ),
      ).toBe(true);
    });

    it("should allow boolean literal assignable to boolean", () => {
      const checker = new TypeChecker(
        { type: "agencyProgram", nodes: [] },
      );
      checker.check();

      expect(
        checker.isAssignable(
          { type: "booleanLiteralType", value: "true" },
          { type: "primitiveType", value: "boolean" },
        ),
      ).toBe(true);
    });

    it("should not allow string assignable to number", () => {
      const checker = new TypeChecker(
        { type: "agencyProgram", nodes: [] },
      );
      checker.check();

      expect(
        checker.isAssignable(
          { type: "primitiveType", value: "string" },
          { type: "primitiveType", value: "number" },
        ),
      ).toBe(false);
    });
  });

  describe("variable reassignment consistency", () => {
    it("should error when reassigning a typed variable with incompatible type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "getNum",
            parameters: [],
            returnType: { type: "primitiveType", value: "number" },
            body: [
              {
                type: "returnStatement",
                value: { type: "number", value: "1" },
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "string" },
            value: { type: "string", segments: [{ type: "text", value: "hello" }] },
          },
          {
            type: "assignment",
            variableName: "x",
            value: {
              type: "functionCall",
              functionName: "getNum",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to type");
      expect(errors[0].variableName).toBe("x");
    });
  });

  describe("graph node type checking", () => {
    it("should check function calls inside graph nodes", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "graphNode",
            nodeName: "main",
            parameters: [],
            body: [
              {
                type: "assignment",
                variableName: "count",
                typeHint: { type: "primitiveType", value: "number" },
                value: { type: "number", value: "5" },
              },
              {
                type: "functionCall",
                functionName: "greet",
                arguments: [{ type: "variableName", value: "count" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
    });
  });

  describe("builtin function type checking", () => {
    it("should type check builtins - print accepts any", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "number" },
            value: { type: "number", value: "42" },
          },
          {
            type: "functionCall",
            functionName: "print",
            arguments: [{ type: "variableName", value: "x" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should pass sleep with a number argument", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "sleep",
            arguments: [{ type: "number", value: "42" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should error sleep with a string argument", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "sleep",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "hello" }] },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
      expect(errors[0].message).toContain("sleep");
    });

    it("should error write with wrong arity", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "write",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "file.txt" }] },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Expected 2 argument(s)");
      expect(errors[0].message).toContain("but got 1");
    });

    it("should infer builtin return type (round returns number)", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [
              {
                type: "functionCall",
                functionName: "round",
                arguments: [{ type: "number", value: "3.14" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
      expect(errors[0].actualType).toBe("number");
      expect(errors[0].expectedType).toBe("string");
    });
  });

  describe("binop type inference", () => {
    it("should infer number for arithmetic operations", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "result",
            value: {
              type: "binOpExpression",
              operator: "+",
              left: { type: "number", value: "1" },
              right: { type: "number", value: "2" },
            },
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [{ type: "variableName", value: "result" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("number");
    });

    it("should infer boolean for comparison operations", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "doSomething",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "result",
            value: {
              type: "binOpExpression",
              operator: "==",
              left: { type: "number", value: "1" },
              right: { type: "number", value: "2" },
            },
          },
          {
            type: "functionCall",
            functionName: "doSomething",
            arguments: [{ type: "variableName", value: "result" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("boolean");
    });

    it("should infer string for + with a string operand", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "doSomething",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "result",
            value: {
              type: "binOpExpression",
              operator: "+",
              left: { type: "string", segments: [{ type: "text", value: "hello " }] },
              right: { type: "number", value: "42" },
            },
          },
          {
            type: "functionCall",
            functionName: "doSomething",
            arguments: [{ type: "variableName", value: "result" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("string");
    });
  });

  describe("array type inference", () => {
    it("should infer number[] for array of numbers", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [
              {
                type: "agencyArray",
                items: [
                  { type: "number", value: "1" },
                  { type: "number", value: "2" },
                  { type: "number", value: "3" },
                ],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("number[]");
    });
  });

  describe("object type inference", () => {
    it("should infer object type with property types", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "doSomething",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "doSomething",
            arguments: [
              {
                type: "agencyObject",
                entries: [
                  {
                    key: "name",
                    value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
                  },
                ],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
    });
  });

  describe("value access type inference", () => {
    it("should resolve property access on typed object", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "doSomething",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "obj",
            typeHint: {
              type: "objectType",
              properties: [
                { key: "name", value: { type: "primitiveType", value: "string" } },
              ],
            },
            value: {
              type: "agencyObject",
              entries: [
                {
                  key: "name",
                  value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
                },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "doSomething",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "obj" },
                chain: [{ kind: "property", name: "name" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });

    it("should resolve index access on typed array", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "nums",
            typeHint: {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "number" },
            },
            value: {
              type: "agencyArray",
              items: [{ type: "number", value: "1" }],
            },
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "nums" },
                chain: [{ kind: "index", index: { type: "number", value: "0" } }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("number");
      expect(errors[0].expectedType).toBe("string");
    });

    it("should resolve .length on array to number", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "nums",
            typeHint: {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "number" },
            },
            value: {
              type: "agencyArray",
              items: [{ type: "number", value: "1" }],
            },
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "nums" },
                chain: [{ kind: "property", name: "length" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("number");
    });
  });

  describe("prompt type inference", () => {
    it("should infer string for prompt in synth mode", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "doSomething",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "doSomething",
            arguments: [
              {
                type: "prompt",
                segments: [{ type: "text", value: "What is 2+2?" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("string");
    });
  });

  describe("variable type inference without annotations", () => {
    it("should infer type from number literal and catch misuse", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" },
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [{ type: "variableName", value: "x" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
      expect(errors[0].actualType).toBe("number");
    });
  });

  describe("for loop variable type inference", () => {
    it("should infer item variable type from array element type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "doSomething",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "names",
            typeHint: {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "string" },
            },
            value: {
              type: "agencyArray",
              items: [
                { type: "string", segments: [{ type: "text", value: "Alice" }] },
              ],
            },
          },
          {
            type: "forLoop",
            itemVar: "name",
            indexVar: "i",
            iterable: { type: "variableName", value: "names" },
            body: [
              {
                type: "functionCall",
                functionName: "doSomething",
                arguments: [{ type: "variableName", value: "name" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });

    it("should infer index variable as number", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "names",
            typeHint: {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "string" },
            },
            value: {
              type: "agencyArray",
              items: [
                { type: "string", segments: [{ type: "text", value: "Alice" }] },
              ],
            },
          },
          {
            type: "forLoop",
            itemVar: "name",
            indexVar: "i",
            iterable: { type: "variableName", value: "names" },
            body: [
              {
                type: "functionCall",
                functionName: "greet",
                arguments: [{ type: "variableName", value: "i" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("number");
      expect(errors[0].expectedType).toBe("string");
    });
  });

  describe("standalone TypeHint nodes", () => {
    it("should use standalone TypeHint for variable type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "typeHint",
            variableName: "myName",
            variableType: { type: "primitiveType", value: "number" },
          },
          {
            type: "assignment",
            variableName: "myName",
            value: { type: "number", value: "42" },
          },
          {
            type: "functionCall",
            functionName: "greet",
            arguments: [{ type: "variableName", value: "myName" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
    });
  });

  describe("boolean literal inference", () => {
    it("should infer boolean type from boolean literal", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "doSomething",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "doSomething",
            arguments: [{ type: "boolean", value: true }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("boolean");
    });
  });

  describe("mixed-type array inference", () => {
    it("should fall back to any for arrays with mixed types", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [
              {
                type: "agencyArray",
                items: [
                  { type: "number", value: "1" },
                  { type: "string", segments: [{ type: "text", value: "hello" }] },
                ],
              },
            ],
          },
        ],
      };

      // Mixed array infers any, so no type error (any is assignable to number)
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });
  });

  describe("chained value access", () => {
    it("should resolve multi-step property chain", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "obj",
            typeHint: {
              type: "objectType",
              properties: [
                {
                  key: "nested",
                  value: {
                    type: "objectType",
                    properties: [
                      { key: "name", value: { type: "primitiveType", value: "string" } },
                    ],
                  },
                },
              ],
            },
            value: {
              type: "agencyObject",
              entries: [
                {
                  key: "nested",
                  value: {
                    type: "agencyObject",
                    entries: [
                      {
                        key: "name",
                        value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "obj" },
                chain: [
                  { kind: "property", name: "nested" },
                  { kind: "property", name: "name" },
                ],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });
  });

  describe("value access on unknown property", () => {
    it("should error for unknown property on a typed object", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "obj",
            typeHint: {
              type: "objectType",
              properties: [
                { key: "name", value: { type: "primitiveType", value: "string" } },
              ],
            },
            value: {
              type: "agencyObject",
              entries: [
                {
                  key: "name",
                  value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
                },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "print",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "obj" },
                chain: [{ kind: "property", name: "nonexistent" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Property 'nonexistent' does not exist on type");
    });

    it("should error for unknown property on a type alias object", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "User",
            aliasedType: {
              type: "objectType",
              properties: [
                { key: "name", value: { type: "primitiveType", value: "string" } },
                { key: "age", value: { type: "primitiveType", value: "number" } },
              ],
            },
          },
          {
            type: "assignment",
            variableName: "response",
            typeHint: { type: "typeAliasVariable", aliasName: "User" },
            value: {
              type: "prompt",
              segments: [{ type: "text", value: "What is your name and age?" }],
            },
          },
          {
            type: "functionCall",
            functionName: "print",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "response" },
                chain: [{ kind: "property", name: "asdasd" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Property 'asdasd' does not exist on type");
    });

    it("should not error for property on untyped variable", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "data",
            value: {
              type: "functionCall",
              functionName: "fetchJSON",
              arguments: [
                { type: "string", segments: [{ type: "text", value: "https://example.com" }] },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "print",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "data" },
                chain: [{ kind: "property", name: "anything" }],
              },
            ],
          },
        ],
      };

      // data is any (fetchJSON returns any), so property access is fine
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });
  });

  describe("method call in access chain", () => {
    it("should return any for method calls", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "arr",
            typeHint: {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "number" },
            },
            value: {
              type: "agencyArray",
              items: [{ type: "number", value: "1" }],
            },
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "arr" },
                chain: [
                  {
                    kind: "methodCall",
                    functionCall: {
                      type: "functionCall",
                      functionName: "map",
                      arguments: [],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      // Method call returns any, so no type error
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });
  });

  describe("reassigning an inferred variable", () => {
    it("should error when reassigning inferred number variable with string", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" },
          },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "string", segments: [{ type: "text", value: "hello" }] },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to type");
      expect(errors[0].variableName).toBe("x");
      expect(errors[0].expectedType).toBe("number");
      expect(errors[0].actualType).toBe("string");
    });
  });

  describe("nested object type inference", () => {
    it("should infer nested object types", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "data",
            value: {
              type: "agencyObject",
              entries: [
                {
                  key: "user",
                  value: {
                    type: "agencyObject",
                    entries: [
                      {
                        key: "name",
                        value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "data" },
                chain: [
                  { kind: "property", name: "user" },
                  { kind: "property", name: "name" },
                ],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });
  });

  describe("type alias in value access", () => {
    it("should resolve type alias when accessing properties", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "User",
            aliasedType: {
              type: "objectType",
              properties: [
                { key: "name", value: { type: "primitiveType", value: "string" } },
                { key: "age", value: { type: "primitiveType", value: "number" } },
              ],
            },
          },
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "user",
            typeHint: { type: "typeAliasVariable", aliasName: "User" },
            value: {
              type: "agencyObject",
              entries: [
                {
                  key: "name",
                  value: { type: "string", segments: [{ type: "text", value: "Alice" }] },
                },
                {
                  key: "age",
                  value: { type: "number", value: "30" },
                },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "user" },
                chain: [{ kind: "property", name: "name" }],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });
  });

  describe("logical operators", () => {
    it("should infer boolean for && operator", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "result",
            value: {
              type: "binOpExpression",
              operator: "&&",
              left: { type: "boolean", value: true },
              right: { type: "boolean", value: false },
            },
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [{ type: "variableName", value: "result" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("boolean");
    });

    it("should infer boolean for || operator", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "result",
            value: {
              type: "binOpExpression",
              operator: "||",
              left: { type: "boolean", value: true },
              right: { type: "boolean", value: false },
            },
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [{ type: "variableName", value: "result" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("boolean");
    });
  });

  describe("arithmetic operators", () => {
    it("should infer number for - operator", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              {
                type: "functionParameter",
                name: "s",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "result",
            value: {
              type: "binOpExpression",
              operator: "-",
              left: { type: "number", value: "10" },
              right: { type: "number", value: "3" },
            },
          },
          {
            type: "functionCall",
            functionName: "expectStr",
            arguments: [{ type: "variableName", value: "result" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("number");
      expect(errors[0].expectedType).toBe("string");
    });

    it("should infer number for * operator", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              {
                type: "functionParameter",
                name: "s",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "result",
            value: {
              type: "binOpExpression",
              operator: "*",
              left: { type: "number", value: "4" },
              right: { type: "number", value: "5" },
            },
          },
          {
            type: "functionCall",
            functionName: "expectStr",
            arguments: [{ type: "variableName", value: "result" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("number");
      expect(errors[0].expectedType).toBe("string");
    });

    it("should infer number for / operator", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              {
                type: "functionParameter",
                name: "s",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "result",
            value: {
              type: "binOpExpression",
              operator: "/",
              left: { type: "number", value: "10" },
              right: { type: "number", value: "2" },
            },
          },
          {
            type: "functionCall",
            functionName: "expectStr",
            arguments: [{ type: "variableName", value: "result" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("number");
      expect(errors[0].expectedType).toBe("string");
    });
  });

  describe("empty array inference", () => {
    it("should infer array type for empty array", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              {
                type: "functionParameter",
                name: "s",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectStr",
            arguments: [
              {
                type: "agencyArray",
                items: [],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to parameter type");
    });
  });

  describe("for loop with non-array iterable", () => {
    it("should infer any for item when iterable is not an array type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "data",
            typeHint: { type: "primitiveType", value: "string" },
            value: { type: "string", segments: [{ type: "text", value: "hello" }] },
          },
          {
            type: "forLoop",
            itemVar: "item",
            iterable: { type: "variableName", value: "data" },
            body: [
              {
                type: "functionCall",
                functionName: "expectNum",
                arguments: [{ type: "variableName", value: "item" }],
              },
            ],
          },
        ],
      };

      // item is any since data is string (not array), so no error
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });
  });

  describe("inferred variable used correctly", () => {
    it("should pass when inferred type matches expected parameter type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "42" },
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [{ type: "variableName", value: "x" }],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });
  });

  describe("assignment value vs annotation mismatch", () => {
    it("should error when function return type conflicts with variable annotation", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "greet",
            parameters: [
              {
                type: "functionParameter",
                name: "name",
                typeHint: { type: "primitiveType", value: "string" },
              },
            ],
            returnType: { type: "primitiveType", value: "string" },
            body: [
              {
                type: "returnStatement",
                value: { type: "string", segments: [{ type: "text", value: "Hello" }] },
              },
            ],
          },
          {
            type: "assignment",
            variableName: "response",
            typeHint: { type: "primitiveType", value: "number" },
            value: {
              type: "functionCall",
              functionName: "greet",
              arguments: [
                { type: "string", segments: [{ type: "text", value: "World" }] },
              ],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to type");
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });

    it("should pass when function return type matches variable annotation", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "getNum",
            parameters: [],
            returnType: { type: "primitiveType", value: "number" },
            body: [
              {
                type: "returnStatement",
                value: { type: "number", value: "42" },
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "number" },
            value: {
              type: "functionCall",
              functionName: "getNum",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should allow prompt assigned to any annotated type (check mode skips prompts)", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "result",
            typeHint: {
              type: "objectType",
              properties: [
                { key: "name", value: { type: "primitiveType", value: "string" } },
              ],
            },
            value: {
              type: "prompt",
              segments: [{ type: "text", value: "What is your name?" }],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should error when literal value conflicts with annotation", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "number" },
            value: { type: "string", segments: [{ type: "text", value: "hello" }] },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("not assignable to type");
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });
  });

  describe("builtin return type inference", () => {
    it("should infer string from input() return type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [
              {
                type: "functionCall",
                functionName: "input",
                arguments: [
                  { type: "string", segments: [{ type: "text", value: "Enter name: " }] },
                ],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });

    it("should infer string from read() return type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [
              {
                type: "functionCall",
                functionName: "read",
                arguments: [
                  { type: "string", segments: [{ type: "text", value: "file.txt" }] },
                ],
              },
            ],
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].actualType).toBe("string");
      expect(errors[0].expectedType).toBe("number");
    });

    it("should infer any from fetchJSON() return type (passes any check)", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [
              {
                type: "functionCall",
                functionName: "fetchJSON",
                arguments: [
                  { type: "string", segments: [{ type: "text", value: "https://example.com" }] },
                ],
              },
            ],
          },
        ],
      };

      // fetchJSON returns any, so it should pass any parameter check
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });
  });

  describe("return type inference", () => {
    it("should infer return type from single return and catch call site mismatch", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "returnStatement",
                value: { type: "string", segments: [{ type: "text", value: "hello" }] },
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "number" },
            value: {
              type: "functionCall",
              functionName: "foo",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("string") && e.message.includes("number"))).toBe(true);
    });

    it("should infer return type from multiple consistent returns", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "bar",
            parameters: [],
            body: [
              {
                type: "ifElse",
                condition: { type: "boolean", value: true },
                thenBody: [
                  {
                    type: "returnStatement",
                    value: { type: "number", value: "1" },
                  },
                ],
                elseBody: [
                  {
                    type: "returnStatement",
                    value: { type: "number", value: "2" },
                  },
                ],
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "string" },
            value: {
              type: "functionCall",
              functionName: "bar",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("number") && e.message.includes("string"))).toBe(true);
    });

    it("should infer void when no return statements", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "noop",
            parameters: [],
            body: [
              {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "string", segments: [{ type: "text", value: "hi" }] }],
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "string" },
            value: {
              type: "functionCall",
              functionName: "noop",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("void") && e.message.includes("string"))).toBe(true);
    });

    it("should fall back to any with inconsistent return types", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "mixed",
            parameters: [],
            body: [
              {
                type: "ifElse",
                condition: { type: "boolean", value: true },
                thenBody: [
                  {
                    type: "returnStatement",
                    value: { type: "string", segments: [{ type: "text", value: "hi" }] },
                  },
                ],
                elseBody: [
                  {
                    type: "returnStatement",
                    value: { type: "number", value: "42" },
                  },
                ],
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "boolean" },
            value: {
              type: "functionCall",
              functionName: "mixed",
              arguments: [],
            },
          },
        ],
      };

      // Inconsistent returns → any → no type error at call site
      const { errors } = typeCheck(program);
      expect(errors.filter((e) => e.message.includes("mixed"))).toHaveLength(0);
    });

    it("should not infinite loop on recursive functions", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "rec",
            parameters: [
              {
                type: "functionParameter",
                name: "n",
                typeHint: { type: "primitiveType", value: "number" },
              },
            ],
            body: [
              {
                type: "returnStatement",
                value: {
                  type: "functionCall",
                  functionName: "rec",
                  arguments: [{ type: "number", value: "1" }],
                },
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "boolean" },
            value: {
              type: "functionCall",
              functionName: "rec",
              arguments: [{ type: "number", value: "5" }],
            },
          },
        ],
      };

      // Should not hang — recursive → any → no error
      const { errors } = typeCheck(program);
      expect(errors.filter((e) => e.message.includes("rec"))).toHaveLength(0);
    });

    it("should collect return inside if/else correctly", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "check",
            parameters: [],
            body: [
              {
                type: "ifElse",
                condition: { type: "boolean", value: true },
                thenBody: [
                  {
                    type: "returnStatement",
                    value: { type: "boolean", value: true },
                  },
                ],
                elseBody: [
                  {
                    type: "returnStatement",
                    value: { type: "boolean", value: false },
                  },
                ],
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "number" },
            value: {
              type: "functionCall",
              functionName: "check",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("boolean") && e.message.includes("number"))).toBe(true);
    });

    it("should prefer explicit return type over inferred type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "typed",
            parameters: [],
            returnType: { type: "primitiveType", value: "string" },
            body: [
              {
                type: "returnStatement",
                value: { type: "number", value: "42" },
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "string" },
            value: {
              type: "functionCall",
              functionName: "typed",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      // The return type mismatch (number vs string) should be caught
      expect(errors.some((e) => e.message.includes("number") && e.message.includes("string"))).toBe(true);
      // But assignment of typed() to string should NOT error (explicit return type is string)
      expect(errors.some((e) => e.message.includes("assignment to 'x'"))).toBe(false);
    });

    it("should infer return type when function returns another function's call", () => {
      // foo is defined before bar, but foo() returns bar()
      // Lazy inference should trigger bar's inference when processing foo
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [],
            body: [
              {
                type: "returnStatement",
                value: {
                  type: "functionCall",
                  functionName: "bar",
                  arguments: [],
                },
              },
            ],
          },
          {
            type: "function",
            functionName: "bar",
            parameters: [],
            body: [
              {
                type: "returnStatement",
                value: { type: "number", value: "7" },
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "string" },
            value: {
              type: "functionCall",
              functionName: "foo",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("number") && e.message.includes("string"))).toBe(true);
    });

    it("should infer return types for graph nodes", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "graphNode",
            nodeName: "myNode",
            parameters: [],
            body: [
              {
                type: "returnStatement",
                value: { type: "number", value: "42" },
              },
            ],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "string" },
            value: {
              type: "functionCall",
              functionName: "myNode",
              arguments: [],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("number") && e.message.includes("string"))).toBe(true);
    });
  });
});
