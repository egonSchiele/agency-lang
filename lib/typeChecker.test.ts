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
            value: { type: "string", segments: [{ type: "text", value: "success" }] },
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
      expect(errors[0].message).toContain("Return type");
      expect(errors[0].message).toContain("not assignable to declared return type");
    });
  });

  describe("literal type assignable to base primitive", () => {
    it("should allow string literal assignable to string", () => {
      const checker = new TypeChecker(
        { type: "agencyProgram", nodes: [] },
      );
      // Need to call check() to initialize, but we test isAssignable directly
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

  describe("builtin functions", () => {
    it("should skip type checking for builtin functions", () => {
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
});
