import { describe, it, expect } from "vitest";
import { TypeChecker, typeCheck } from "./typeChecker/index.js";
import { AgencyProgram, VariableType } from "./types.js";
import { buildCompilationUnit } from "./compilationUnit.js";
import type { CompilationUnit } from "./compilationUnit.js";

function withImports(
  program: AgencyProgram,
  importedFunctions: CompilationUnit["importedFunctions"],
): CompilationUnit {
  const info = buildCompilationUnit(program);
  info.importedFunctions = importedFunctions;
  return info;
}

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
              type: "functionCall",
              functionName: "llm",
              arguments: [{ type: "string", segments: [{ type: "text", value: "Pick a status" }] }],
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
                  type: "functionCall",
                  functionName: "llm",
                  arguments: [{ type: "string", segments: [{ type: "text", value: "What is your name?" }] }],
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

    it("should allow objectType assignable to object primitive", () => {
      const checker = new TypeChecker(
        { type: "agencyProgram", nodes: [] },
      );
      checker.check();

      expect(
        checker.isAssignable(
          {
            type: "objectType",
            properties: [
              { key: "name", value: { type: "primitiveType", value: "string" } },
            ],
          },
          { type: "primitiveType", value: "object" },
        ),
      ).toBe(true);
    });

    it("should not allow object primitive assignable to objectType", () => {
      const checker = new TypeChecker(
        { type: "agencyProgram", nodes: [] },
      );
      checker.check();

      expect(
        checker.isAssignable(
          { type: "primitiveType", value: "object" },
          {
            type: "objectType",
            properties: [
              { key: "name", value: { type: "primitiveType", value: "string" } },
            ],
          },
        ),
      ).toBe(false);
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
                arguments: [
                  { type: "number", value: "3.14" },
                  { type: "number", value: "2" },
                ],
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
                type: "functionCall",
                functionName: "llm",
                arguments: [{ type: "string", segments: [{ type: "text", value: "What is 2+2?" }] }],
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
              type: "functionCall",
              functionName: "llm",
              arguments: [{ type: "string", segments: [{ type: "text", value: "What is your name and age?" }] }],
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
      expect(errors[0].actualType).toBe('"hello"');
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
    it("should error when iterable is not an array type", () => {
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

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/For-loop iterable must be an array/);
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
              type: "functionCall",
              functionName: "llm",
              arguments: [{ type: "string", segments: [{ type: "text", value: "What is your name?" }] }],
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
      expect(errors[0].actualType).toBe('"hello"');
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

  describe("any and unknown primitive types", () => {
    it("should allow assigning any type to a variable typed as 'any'", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "any" },
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
      expect(errors).toHaveLength(0);
    });

    it("should allow passing a primitiveType('any') variable to a typed parameter", () => {
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
            typeHint: { type: "primitiveType", value: "any" },
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
      expect(errors).toHaveLength(0);
    });

    it("should allow property access on primitiveType('any')", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "any" },
            value: { type: "number", value: "42" },
          },
          {
            type: "assignment",
            variableName: "y",
            value: {
              type: "valueAccess",
              base: { type: "variableName", value: "x" },
              chain: [{ kind: "property", name: "foo" }],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should allow assigning any type to a variable typed as 'unknown'", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "unknown" },
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
      expect(errors).toHaveLength(0);
    });

    it("should error when assigning 'unknown' to a typed variable", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "unknown" },
            value: { type: "number", value: "42" },
          },
          {
            type: "assignment",
            variableName: "y",
            typeHint: { type: "primitiveType", value: "string" },
            value: { type: "variableName", value: "x" },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("unknown");
      expect(errors[0].message).toContain("string");
    });

    it("should error when passing 'unknown' to a typed parameter", () => {
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
            typeHint: { type: "primitiveType", value: "unknown" },
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
      expect(errors[0].message).toContain("unknown");
    });

    it("should allow assigning 'unknown' to 'unknown'", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "unknown" },
            value: { type: "number", value: "42" },
          },
          {
            type: "assignment",
            variableName: "y",
            typeHint: { type: "primitiveType", value: "unknown" },
            value: { type: "variableName", value: "x" },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("should allow assigning 'unknown' to 'any'", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "unknown" },
            value: { type: "number", value: "42" },
          },
          {
            type: "assignment",
            variableName: "y",
            typeHint: { type: "primitiveType", value: "any" },
            value: { type: "variableName", value: "x" },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(0);
    });

    it("validates an unannotated reassignment against the type in effect at that point, not the final type", () => {
      // let x: string = "a"     OK
      // x = "b"                  OK at this point — x is still string
      // let x: number = 1        ERROR: number not assignable to string (re-decl)
      // The middle reassignment must NOT be flagged just because x is later
      // re-declared as number.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "string" },
            value: { type: "string", segments: [{ type: "text", value: "a" }] },
          },
          {
            type: "assignment",
            variableName: "x",
            value: { type: "string", segments: [{ type: "text", value: "b" }] },
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "number" },
            value: { type: "number", value: "1" },
          },
        ],
      };

      const { errors } = typeCheck(program);
      // Exactly one error: the re-declaration `let x: number` clashing with prior `string`.
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("'number' is not assignable to type 'string'");
    });

    it("should error on property access on 'unknown'", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: { type: "primitiveType", value: "unknown" },
            value: { type: "number", value: "42" },
          },
          {
            type: "assignment",
            variableName: "y",
            value: {
              type: "valueAccess",
              base: { type: "variableName", value: "x" },
              chain: [{ kind: "property", name: "foo" }],
            },
          },
        ],
      };

      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("foo");
      expect(errors[0].message).toContain("unknown");
    });
  });

  describe("v2: boolean condition checks", () => {
    it("flags non-boolean if condition", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "n",
            typeHint: { type: "primitiveType", value: "number" },
            value: { type: "number", value: "5" },
          },
          {
            type: "ifElse",
            condition: { type: "variableName", value: "n" },
            thenBody: [],
          },
        ],
      };
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/not assignable.*boolean/);
    });

    it("accepts boolean if condition", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "ok",
            typeHint: { type: "primitiveType", value: "boolean" },
            value: { type: "boolean", value: true },
          },
          {
            type: "ifElse",
            condition: { type: "variableName", value: "ok" },
            thenBody: [],
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("flags non-boolean while condition", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "s",
            typeHint: { type: "primitiveType", value: "string" },
            value: { type: "string", segments: [{ type: "text", value: "x" }] },
          },
          {
            type: "whileLoop",
            condition: { type: "variableName", value: "s" },
            body: [],
          },
        ],
      };
      const { errors } = typeCheck(program);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/not assignable.*boolean/);
    });
  });

  describe("v2: splat argument checking", () => {
    it("accepts splat of matching element type", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "takesNums",
            parameters: [
              { type: "functionParameter", name: "a", typeHint: { type: "primitiveType", value: "number" } },
              { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "number" } },
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
              items: [
                { type: "number", value: "1" },
                { type: "number", value: "2" },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "takesNums",
            arguments: [
              { type: "splat", value: { type: "variableName", value: "nums" } },
            ],
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("flags splat element type that is not assignable to remaining params", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "takesNums",
            parameters: [
              { type: "functionParameter", name: "a", typeHint: { type: "primitiveType", value: "number" } },
              { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "number" } },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "strs",
            typeHint: {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "string" },
            },
            value: {
              type: "agencyArray",
              items: [{ type: "string", segments: [{ type: "text", value: "a" }] }],
            },
          },
          {
            type: "functionCall",
            functionName: "takesNums",
            arguments: [
              { type: "splat", value: { type: "variableName", value: "strs" } },
            ],
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].message).toMatch(/Splat element type 'string'.*not assignable.*'number'/);
    });

    it("flags non-array splat source", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "anyFn",
            parameters: [
              { type: "functionParameter", name: "x", typeHint: { type: "primitiveType", value: "any" } },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "n",
            typeHint: { type: "primitiveType", value: "number" },
            value: { type: "number", value: "1" },
          },
          {
            type: "functionCall",
            functionName: "anyFn",
            arguments: [
              { type: "splat", value: { type: "variableName", value: "n" } },
            ],
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.some((e) => /Splat argument must be an array/.test(e.message))).toBe(true);
    });
  });

  describe("v2: print/printJSON varargs", () => {
    it("accepts any number of args to print", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "print",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "a" }] },
              { type: "number", value: "1" },
              { type: "boolean", value: true },
            ],
          },
          { type: "functionCall", functionName: "print", arguments: [] },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });
  });

  describe("v2: object literal splat is later-wins", () => {
    it("explicit key after splat overrides splat type", () => {
      // const a = { x: 1 }; const b = { ...a, x: "hello" }; b.x : string
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "a",
            value: {
              type: "agencyObject",
              entries: [{ key: "x", value: { type: "number", value: "1" } }],
            },
          },
          {
            type: "assignment",
            variableName: "b",
            value: {
              type: "agencyObject",
              entries: [
                { type: "splat", value: { type: "variableName", value: "a" } },
                { key: "x", value: { type: "string", segments: [{ type: "text", value: "hi" }] } },
              ],
            },
          },
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              { type: "functionParameter", name: "s", typeHint: { type: "primitiveType", value: "string" } },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectStr",
            arguments: [
              {
                type: "valueAccess",
                base: { type: "variableName", value: "b" },
                chain: [{ kind: "property", name: "x" }],
              },
            ],
          },
        ],
      };
      // b.x should resolve to string (overriding a.x's number), so no error.
      expect(typeCheck(program).errors).toHaveLength(0);
    });
  });

  describe("v2: scope walks through nested blocks", () => {
    it("declarations inside parallel block are visible after", () => {
      // parallel { let x: number = 1 } expectNum(x)
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectNum",
            parameters: [
              { type: "functionParameter", name: "n", typeHint: { type: "primitiveType", value: "number" } },
            ],
            body: [],
          },
          {
            type: "parallelBlock",
            body: [
              {
                type: "assignment",
                variableName: "x",
                typeHint: { type: "primitiveType", value: "number" },
                value: { type: "number", value: "1" },
              },
            ],
          },
          {
            type: "functionCall",
            functionName: "expectNum",
            arguments: [{ type: "variableName", value: "x" }],
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("declarations inside seq block are visible after", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              { type: "functionParameter", name: "s", typeHint: { type: "primitiveType", value: "string" } },
            ],
            body: [],
          },
          {
            type: "seqBlock",
            body: [
              {
                type: "assignment",
                variableName: "x",
                typeHint: { type: "primitiveType", value: "number" },
                value: { type: "number", value: "1" },
              },
            ],
          },
          {
            type: "functionCall",
            functionName: "expectStr",
            arguments: [{ type: "variableName", value: "x" }],
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].message).toMatch(/not assignable to parameter type 'string'/);
    });

    it("inline handler param is visible inside handler body", () => {
      // handle { ... } catch (err: string) { expectStr(err) }
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              { type: "functionParameter", name: "s", typeHint: { type: "primitiveType", value: "string" } },
            ],
            body: [],
          },
          {
            type: "handleBlock",
            body: [],
            handler: {
              kind: "inline",
              param: { type: "functionParameter", name: "err", typeHint: { type: "primitiveType", value: "string" } },
              body: [
                {
                  type: "functionCall",
                  functionName: "expectStr",
                  arguments: [{ type: "variableName", value: "err" }],
                },
              ],
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("imported function call uses imported signature for return type", () => {
      // Simulates `import { add } from "..."; add(1, 2)` and verifies the
      // typechecker pulls the imported signature, not "any".
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              { type: "functionParameter", name: "s", typeHint: { type: "primitiveType", value: "string" } },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectStr",
            arguments: [
              {
                type: "functionCall",
                functionName: "add",
                arguments: [
                  { type: "number", value: "1" },
                  { type: "number", value: "2" },
                ],
              },
            ],
          },
        ],
      };
      const info = withImports(program, {
        add: {
          parameters: [
            { type: "functionParameter", name: "a", typeHint: { type: "primitiveType", value: "number" } },
            { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "number" } },
          ],
          returnType: { type: "primitiveType", value: "number" },
        },
      });
      const { errors } = typeCheck(program, {}, info);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/'number' is not assignable to parameter type 'string'/);
    });

    it("imported function arity is checked", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "add",
            arguments: [{ type: "number", value: "1" }],
          },
        ],
      };
      const info = withImports(program, {
        add: {
          parameters: [
            { type: "functionParameter", name: "a", typeHint: { type: "primitiveType", value: "number" } },
            { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "number" } },
          ],
          returnType: { type: "primitiveType", value: "number" },
        },
      });
      const errors = typeCheck(program, {}, info).errors;
      expect(errors.some((e) => /Expected 2 argument\(s\) for 'add'/.test(e.message))).toBe(true);
    });

    it("imported function with optional default arg accepts fewer args", () => {
      // def range(start: number, end: number = -1) — calling range(5) is fine.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "range",
            arguments: [{ type: "number", value: "5" }],
          },
        ],
      };
      const info = withImports(program, {
        range: {
          parameters: [
            { type: "functionParameter", name: "start", typeHint: { type: "primitiveType", value: "number" } },
            {
              type: "functionParameter",
              name: "end",
              typeHint: { type: "primitiveType", value: "number" },
              defaultValue: { type: "number", value: "-1" },
            },
          ],
          returnType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
        },
      });
      expect(typeCheck(program, {}, info).errors).toHaveLength(0);
    });

    it("imported variadic function accepts any number of args (element-typed)", () => {
      // def join(...parts: string[]): string — element type is string.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "join",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "a" }] },
              { type: "string", segments: [{ type: "text", value: "b" }] },
              { type: "string", segments: [{ type: "text", value: "c" }] },
            ],
          },
          {
            type: "functionCall",
            functionName: "join",
            arguments: [{ type: "number", value: "1" }],
          },
        ],
      };
      const info = withImports(program, {
        join: {
          parameters: [
            {
              type: "functionParameter",
              name: "parts",
              typeHint: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "string" },
              },
              variadic: true,
            },
          ],
          returnType: { type: "primitiveType", value: "string" },
        },
      });
      const errors = typeCheck(program, {}, info).errors;
      // First call OK; second should fail (number not assignable to string).
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/'number' is not assignable to parameter type 'string'/);
    });

    it("warns when a local def shadows an imported function", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "add",
            parameters: [],
            body: [],
          },
        ],
      };
      const info = withImports(program, {
        add: {
          parameters: [],
          returnType: { type: "primitiveType", value: "number" },
        },
      });
      const errors = typeCheck(program, {}, info).errors;
      const shadow = errors.find((e) => /'add' shadows an imported function/.test(e.message));
      expect(shadow).toBeDefined();
      expect(shadow!.severity).toBe("warning");
    });

    it("does not register importedFunctions placeholders when no SymbolTable", () => {
      // Regression: stdin / no-SymbolTable mode used to create placeholder
      // entries with parameters: [] for every auto-imported stdlib name,
      // leading to bogus "Expected 0 args" errors on calls like print("x").
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "importStatement",
            modulePath: "std::index",
            isAgencyImport: true,
            importedNames: [
              {
                type: "namedImport",
                importedNames: ["print"],
                aliases: {},
                safeNames: [],
              },
            ],
          },
          {
            type: "functionCall",
            functionName: "print",
            arguments: [
              { type: "string", segments: [{ type: "text", value: "x" }] },
            ],
          },
        ],
      };
      // No SymbolTable passed → typeCheck builds a CompilationUnit with
      // empty importedFunctions and falls through to the builtin signature.
      const errors = typeCheck(program).errors;
      expect(errors.filter((e) => /Expected.*argument\(s\) for 'print'/.test(e.message))).toHaveLength(0);
    });

    it("local definition wins over imported function", () => {
      // Local `add` returns string; if local wins, expectStr(add(...)) is OK.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "add",
            parameters: [],
            body: [],
            returnType: { type: "primitiveType", value: "string" },
          },
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              { type: "functionParameter", name: "s", typeHint: { type: "primitiveType", value: "string" } },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectStr",
            arguments: [
              { type: "functionCall", functionName: "add", arguments: [] },
            ],
          },
        ],
      };
      const info = withImports(program, {
        add: {
          parameters: [],
          returnType: { type: "primitiveType", value: "number" },
        },
      });
      const errors = typeCheck(program, {}, info).errors;
      // Only the shadow warning; no type error from the call.
      expect(errors.some((e) => /'add' shadows/.test(e.message))).toBe(true);
      expect(errors.some((e) => /not assignable/.test(e.message))).toBe(false);
    });

    it("match block case body is type-checked", () => {
      // match (n) { 1 -> expectStr(n) }
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectStr",
            parameters: [
              { type: "functionParameter", name: "s", typeHint: { type: "primitiveType", value: "string" } },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "n",
            typeHint: { type: "primitiveType", value: "number" },
            value: { type: "number", value: "1" },
          },
          {
            type: "matchBlock",
            expression: { type: "variableName", value: "n" },
            cases: [
              {
                type: "matchBlockCase",
                caseValue: { type: "number", value: "1" },
                body: {
                  type: "functionCall",
                  functionName: "expectStr",
                  arguments: [{ type: "variableName", value: "n" }],
                },
              },
            ],
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].message).toMatch(/not assignable to parameter type 'string'/);
    });
  });

  describe("v2: Result type synth", () => {
    it("success(x) synths as Result<typeof x, any>", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectResult",
            parameters: [
              {
                type: "functionParameter",
                name: "r",
                typeHint: {
                  type: "resultType",
                  successType: { type: "primitiveType", value: "number" },
                  failureType: { type: "primitiveType", value: "any" },
                },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectResult",
            arguments: [
              {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "number", value: "10" }],
              },
            ],
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("success(string) is not assignable to Result<number, any>", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectResult",
            parameters: [
              {
                type: "functionParameter",
                name: "r",
                typeHint: {
                  type: "resultType",
                  successType: { type: "primitiveType", value: "number" },
                  failureType: { type: "primitiveType", value: "any" },
                },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expectResult",
            arguments: [
              {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "string", segments: [{ type: "text", value: "x" }] }],
              },
            ],
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].message).toMatch(/not assignable to parameter type/);
    });

    it("failure(msg) synths as Result<any, typeof msg>", () => {
      // failure("err") → Result<any, string>; should be assignable to Result<any, any>.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "r",
            typeHint: {
              type: "resultType",
              successType: { type: "primitiveType", value: "any" },
              failureType: { type: "primitiveType", value: "any" },
            },
            value: {
              type: "functionCall",
              functionName: "failure",
              arguments: [{ type: "string", segments: [{ type: "text", value: "oops" }] }],
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("try expr wraps inner return type as Result", () => {
      // def half(): number { ... } ; const r: Result<number, any> = try half()
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "half",
            parameters: [],
            returnType: { type: "primitiveType", value: "number" },
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: {
              type: "resultType",
              successType: { type: "primitiveType", value: "number" },
              failureType: { type: "primitiveType", value: "any" },
            },
            value: {
              type: "tryExpression",
              call: { type: "functionCall", functionName: "half", arguments: [] },
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("try on a Result-returning function passes through", () => {
      // def safeDiv(): Result<number, any> { ... } ; const r: Result<number, any> = try safeDiv()
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "safeDiv",
            parameters: [],
            returnType: {
              type: "resultType",
              successType: { type: "primitiveType", value: "number" },
              failureType: { type: "primitiveType", value: "any" },
            },
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: {
              type: "resultType",
              successType: { type: "primitiveType", value: "number" },
              failureType: { type: "primitiveType", value: "any" },
            },
            value: {
              type: "tryExpression",
              call: { type: "functionCall", functionName: "safeDiv", arguments: [] },
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("`Result<T> catch T` unwraps to T", () => {
      // const n: number = success(10) catch 0  -> n is number, no error
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "n",
            typeHint: { type: "primitiveType", value: "number" },
            value: {
              type: "binOpExpression",
              operator: "catch",
              left: {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "number", value: "10" }],
              },
              right: { type: "number", value: "0" },
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("catch flags default arm not assignable to success type", () => {
      // success(10) catch "wrong" -> expected number, got string
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "n",
            typeHint: { type: "primitiveType", value: "number" },
            value: {
              type: "binOpExpression",
              operator: "catch",
              left: {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "number", value: "10" }],
              },
              right: { type: "string", segments: [{ type: "text", value: "x" }] },
            },
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.some((e) => /catch default/.test(e.message))).toBe(true);
    });

    it("pipe synths as Result wrapping right-hand return type", () => {
      // def half(x: number): number { ... }
      // const r: Result<number, any> = success(10) |> half
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "half",
            parameters: [
              { type: "functionParameter", name: "x", typeHint: { type: "primitiveType", value: "number" } },
            ],
            returnType: { type: "primitiveType", value: "number" },
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: {
              type: "resultType",
              successType: { type: "primitiveType", value: "number" },
              failureType: { type: "primitiveType", value: "any" },
            },
            value: {
              type: "binOpExpression",
              operator: "|>",
              left: {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "number", value: "10" }],
              },
              right: { type: "variableName", value: "half" },
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("pipe whose right-hand returns a Result does not double-wrap", () => {
      // def safeHalf(x: number): Result<number, any> { ... }
      // const r: Result<number, any> = success(10) |> safeHalf
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "safeHalf",
            parameters: [
              { type: "functionParameter", name: "x", typeHint: { type: "primitiveType", value: "number" } },
            ],
            returnType: {
              type: "resultType",
              successType: { type: "primitiveType", value: "number" },
              failureType: { type: "primitiveType", value: "any" },
            },
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: {
              type: "resultType",
              successType: { type: "primitiveType", value: "number" },
              failureType: { type: "primitiveType", value: "any" },
            },
            value: {
              type: "binOpExpression",
              operator: "|>",
              left: {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "number", value: "10" }],
              },
              right: { type: "variableName", value: "safeHalf" },
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("pipe with a functionCall RHS resolves to its return type", () => {
      // const r: Result<string, any> = success(10) |> labeler(?, "tag")
      // Right is a functionCall (not a bare variableName), so synth flows
      // through the regular call path rather than the function-reference
      // shortcut.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "labeler",
            parameters: [
              { type: "functionParameter", name: "n", typeHint: { type: "primitiveType", value: "number" } },
              { type: "functionParameter", name: "tag", typeHint: { type: "primitiveType", value: "string" } },
            ],
            returnType: { type: "primitiveType", value: "string" },
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: {
              type: "resultType",
              successType: { type: "primitiveType", value: "string" },
              failureType: { type: "primitiveType", value: "any" },
            },
            value: {
              type: "binOpExpression",
              operator: "|>",
              left: {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "number", value: "10" }],
              },
              right: {
                type: "functionCall",
                functionName: "labeler",
                arguments: [
                  { type: "placeholder" },
                  { type: "string", segments: [{ type: "text", value: "tag" }] },
                ],
              },
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("function with branched success/failure returns infers as Result<T, E>", () => {
      // def foo(b: boolean): Result {
      //   if (b) { return success(10) } else { return failure("err") }
      // }
      // Inferred return should be Result<number, string>, so this assignment
      // accepts and `failure(42)` would NOT (failureType is string).
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "foo",
            parameters: [
              { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "boolean" } },
            ],
            body: [
              {
                type: "ifElse",
                condition: { type: "variableName", value: "b" },
                thenBody: [
                  {
                    type: "returnStatement",
                    value: {
                      type: "functionCall",
                      functionName: "success",
                      arguments: [{ type: "number", value: "10" }],
                    },
                  },
                ],
                elseBody: [
                  {
                    type: "returnStatement",
                    value: {
                      type: "functionCall",
                      functionName: "failure",
                      arguments: [{ type: "string", segments: [{ type: "text", value: "err" }] }],
                    },
                  },
                ],
              },
            ],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: {
              type: "resultType",
              successType: { type: "primitiveType", value: "number" },
              failureType: { type: "primitiveType", value: "string" },
            },
            value: {
              type: "functionCall",
              functionName: "foo",
              arguments: [{ type: "boolean", value: true }],
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("catch on a non-Result still validates default vs left type", () => {
      // const n: number = 42 catch "wrong"
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "n",
            typeHint: { type: "primitiveType", value: "number" },
            value: {
              type: "binOpExpression",
              operator: "catch",
              left: { type: "number", value: "42" },
              right: { type: "string", segments: [{ type: "text", value: "wrong" }] },
            },
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.some((e) => /catch default/.test(e.message))).toBe(true);
    });

    it("user-defined success/failure functions are rejected as reserved", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "success",
            parameters: [],
            returnType: { type: "primitiveType", value: "string" },
            body: [],
          },
          {
            type: "function",
            functionName: "failure",
            parameters: [],
            returnType: { type: "primitiveType", value: "string" },
            body: [],
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(
        errors.some((e) => /'success' is a reserved built-in/.test(e.message)),
      ).toBe(true);
      expect(
        errors.some((e) => /'failure' is a reserved built-in/.test(e.message)),
      ).toBe(true);
    });

    it("user-defined Result type alias is rejected as reserved", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "Result",
            aliasedType: { type: "primitiveType", value: "string" },
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(
        errors.some((e) => /'Result' is a reserved built-in type/.test(e.message)),
      ).toBe(true);
    });

    it("pipe synth flows the actual return type (regression: variableName RHS used to be 'any')", () => {
      // const r: Result<string, any> = success(10) |> labeler
      // labeler returns number. Pipe should synth as Result<number, any>,
      // which is NOT assignable to Result<string, any>.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "labeler",
            parameters: [
              { type: "functionParameter", name: "n", typeHint: { type: "primitiveType", value: "number" } },
            ],
            returnType: { type: "primitiveType", value: "number" },
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: {
              type: "resultType",
              successType: { type: "primitiveType", value: "string" },
              failureType: { type: "primitiveType", value: "any" },
            },
            value: {
              type: "binOpExpression",
              operator: "|>",
              left: {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "number", value: "10" }],
              },
              right: { type: "variableName", value: "labeler" },
            },
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].message).toMatch(/not assignable/);
    });
  });

  describe("v2: Result type corner cases", () => {
    const num: VariableType = { type: "primitiveType", value: "number" };
    const str: VariableType = { type: "primitiveType", value: "string" };
    const anyT: VariableType = { type: "primitiveType", value: "any" };
    const result = (s: VariableType, f: VariableType): VariableType => ({
      type: "resultType",
      successType: s,
      failureType: f,
    });

    it("success({a:1, b:'x'}) synths as Result<{a:number,b:string}, any>", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expect",
            parameters: [
              {
                type: "functionParameter",
                name: "r",
                typeHint: result(
                  {
                    type: "objectType",
                    properties: [
                      { key: "a", value: num },
                      { key: "b", value: str },
                    ],
                  },
                  anyT,
                ),
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expect",
            arguments: [
              {
                type: "functionCall",
                functionName: "success",
                arguments: [
                  {
                    type: "agencyObject",
                    entries: [
                      { key: "a", value: { type: "number", value: "1" } },
                      { key: "b", value: { type: "string", segments: [{ type: "text", value: "x" }] } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("success() with no args fails arity check", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "functionCall",
            functionName: "success",
            arguments: [],
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.some((e) => /Expected 1 argument\(s\) for 'success'/.test(e.message))).toBe(true);
    });

    it("all-success returns infer as Result<T, any>", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "f",
            parameters: [
              { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "boolean" } },
            ],
            body: [
              {
                type: "ifElse",
                condition: { type: "variableName", value: "b" },
                thenBody: [
                  {
                    type: "returnStatement",
                    value: {
                      type: "functionCall",
                      functionName: "success",
                      arguments: [{ type: "number", value: "1" }],
                    },
                  },
                ],
                elseBody: [
                  {
                    type: "returnStatement",
                    value: {
                      type: "functionCall",
                      functionName: "success",
                      arguments: [{ type: "number", value: "2" }],
                    },
                  },
                ],
              },
            ],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: result(num, anyT),
            value: {
              type: "functionCall",
              functionName: "f",
              arguments: [{ type: "boolean", value: true }],
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("all-failure returns infer as Result<any, E>", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "f",
            parameters: [
              { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "boolean" } },
            ],
            body: [
              {
                type: "ifElse",
                condition: { type: "variableName", value: "b" },
                thenBody: [
                  {
                    type: "returnStatement",
                    value: {
                      type: "functionCall",
                      functionName: "failure",
                      arguments: [{ type: "string", segments: [{ type: "text", value: "a" }] }],
                    },
                  },
                ],
                elseBody: [
                  {
                    type: "returnStatement",
                    value: {
                      type: "functionCall",
                      functionName: "failure",
                      arguments: [{ type: "string", segments: [{ type: "text", value: "b" }] }],
                    },
                  },
                ],
              },
            ],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: result(anyT, str),
            value: {
              type: "functionCall",
              functionName: "f",
              arguments: [{ type: "boolean", value: true }],
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("mixed Result + non-Result returns infer as a union", () => {
      // f returns either 5 or success(10). Assigning to number should fail
      // (union includes Result), but assigning to a union of both should pass.
      const mixed: VariableType = {
        type: "unionType",
        types: [num, result(num, anyT)],
      };
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "f",
            parameters: [
              { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "boolean" } },
            ],
            body: [
              {
                type: "ifElse",
                condition: { type: "variableName", value: "b" },
                thenBody: [
                  { type: "returnStatement", value: { type: "number", value: "5" } },
                ],
                elseBody: [
                  {
                    type: "returnStatement",
                    value: {
                      type: "functionCall",
                      functionName: "success",
                      arguments: [{ type: "number", value: "10" }],
                    },
                  },
                ],
              },
            ],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: mixed,
            value: {
              type: "functionCall",
              functionName: "f",
              arguments: [{ type: "boolean", value: true }],
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("Result<number, string> widens to Result<any, any>", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "specific",
            parameters: [],
            returnType: result(num, str),
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: result(anyT, anyT),
            value: { type: "functionCall", functionName: "specific", arguments: [] },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("Result<any, any> 'narrows' to Result<number, string> (any goes both ways)", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "wide",
            parameters: [],
            returnType: result(anyT, anyT),
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: result(num, str),
            value: { type: "functionCall", functionName: "wide", arguments: [] },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("Result<number, string> is not assignable to plain number", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "f",
            parameters: [],
            returnType: result(num, str),
            body: [],
          },
          {
            type: "assignment",
            variableName: "n",
            typeHint: num,
            value: { type: "functionCall", functionName: "f", arguments: [] },
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.some((e) => /not assignable/.test(e.message))).toBe(true);
    });

    it("type alias Result<number, string> resolves through assignability", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "MyResult",
            aliasedType: result(num, str),
          },
          {
            type: "function",
            functionName: "expect",
            parameters: [
              {
                type: "functionParameter",
                name: "r",
                typeHint: { type: "typeAliasVariable", aliasName: "MyResult" },
              },
            ],
            body: [],
          },
          {
            type: "functionCall",
            functionName: "expect",
            arguments: [
              {
                type: "functionCall",
                functionName: "success",
                arguments: [{ type: "number", value: "1" }],
              },
            ],
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("multi-step pipe chain types as Result<lastReturn>", () => {
      // success(10) |> half |> half : Result<number, any>
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "half",
            parameters: [
              { type: "functionParameter", name: "x", typeHint: num },
            ],
            returnType: num,
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: result(num, anyT),
            value: {
              type: "binOpExpression",
              operator: "|>",
              left: {
                type: "binOpExpression",
                operator: "|>",
                left: {
                  type: "functionCall",
                  functionName: "success",
                  arguments: [{ type: "number", value: "10" }],
                },
                right: { type: "variableName", value: "half" },
              },
              right: { type: "variableName", value: "half" },
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("try on a void-returning function wraps as Result<void, any>", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "noop",
            parameters: [],
            returnType: { type: "primitiveType", value: "void" },
            body: [],
          },
          {
            type: "assignment",
            variableName: "r",
            typeHint: result({ type: "primitiveType", value: "void" }, anyT),
            value: {
              type: "tryExpression",
              call: { type: "functionCall", functionName: "noop", arguments: [] },
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("Result.value access types as any (until narrowing lands)", () => {
      // const r: Result<number, any> = success(10)
      // const n: string = r.value   -- string, not number; .value is `any` so this passes.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "r",
            typeHint: result(num, anyT),
            value: {
              type: "functionCall",
              functionName: "success",
              arguments: [{ type: "number", value: "10" }],
            },
          },
          {
            type: "assignment",
            variableName: "n",
            typeHint: str,
            value: {
              type: "valueAccess",
              base: { type: "variableName", value: "r" },
              chain: [{ kind: "property", name: "value" }],
            },
          },
        ],
      };
      // Result.value escapes to any; assignable to anything.
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("Result.error / .checkpoint / .args also type as any", () => {
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "r",
            typeHint: result(num, anyT),
            value: {
              type: "functionCall",
              functionName: "failure",
              arguments: [{ type: "string", segments: [{ type: "text", value: "x" }] }],
            },
          },
          {
            type: "assignment",
            variableName: "e",
            typeHint: str,
            value: {
              type: "valueAccess",
              base: { type: "variableName", value: "r" },
              chain: [{ kind: "property", name: "error" }],
            },
          },
          {
            type: "assignment",
            variableName: "ck",
            typeHint: anyT,
            value: {
              type: "valueAccess",
              base: { type: "variableName", value: "r" },
              chain: [{ kind: "property", name: "checkpoint" }],
            },
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("Result.unknownField still errors", () => {
      // Sanity: only the known runtime fields escape; typos still fire.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "r",
            typeHint: result(num, anyT),
            value: {
              type: "functionCall",
              functionName: "success",
              arguments: [{ type: "number", value: "10" }],
            },
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: anyT,
            value: {
              type: "valueAccess",
              base: { type: "variableName", value: "r" },
              chain: [{ kind: "property", name: "vlaue" }], // typo
            },
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.some((e) => /Property 'vlaue'/.test(e.message))).toBe(true);
    });
  });

  describe("v2: bang (!) validation", () => {
    const num: VariableType = { type: "primitiveType", value: "number" };
    const str: VariableType = { type: "primitiveType", value: "string" };
    const person: VariableType = {
      type: "objectType",
      properties: [{ key: "name", value: str }],
    };
    const resultPersonStr: VariableType = {
      type: "resultType",
      successType: person,
      failureType: str,
    };

    it("declares a validated variable as Result<T, string>", () => {
      // const x: Person! = { name: "alice" }; expectResult(x)
      // expectResult takes Result<Person, string>; passing x must typecheck.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectResult",
            parameters: [
              { type: "functionParameter", name: "r", typeHint: resultPersonStr },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: person,
            validated: true,
            value: {
              type: "agencyObject",
              entries: [
                { key: "name", value: { type: "string", segments: [{ type: "text", value: "alice" }] } },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "expectResult",
            arguments: [{ type: "variableName", value: "x" }],
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("does not rewrap a Result type with bang", () => {
      // const x: Result<Person, string>! = success({...}); expectResult(x)
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "function",
            functionName: "expectResult",
            parameters: [
              { type: "functionParameter", name: "r", typeHint: resultPersonStr },
            ],
            body: [],
          },
          {
            type: "assignment",
            variableName: "x",
            typeHint: resultPersonStr,
            validated: true,
            value: {
              type: "functionCall",
              functionName: "success",
              arguments: [
                {
                  type: "agencyObject",
                  entries: [
                    { key: "name", value: { type: "string", segments: [{ type: "text", value: "alice" }] } },
                  ],
                },
              ],
            },
          },
          {
            type: "functionCall",
            functionName: "expectResult",
            arguments: [{ type: "variableName", value: "x" }],
          },
        ],
      };
      expect(typeCheck(program).errors).toHaveLength(0);
    });

    it("checks the RHS of a validated assignment against the un-bang'd type", () => {
      // const x: number! = "not a number" — RHS is checked against `number`.
      const program: AgencyProgram = {
        type: "agencyProgram",
        nodes: [
          {
            type: "assignment",
            variableName: "x",
            typeHint: num,
            validated: true,
            value: { type: "string", segments: [{ type: "text", value: "not a number" }] },
          },
        ],
      };
      const errors = typeCheck(program).errors;
      expect(errors.some((e) => /not assignable/i.test(e.message))).toBe(true);
    });
  });
});
