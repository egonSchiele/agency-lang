import { describe, it, expect } from "vitest";
import { generateTypeScript } from "./typescriptGenerator";
import { ADLProgram } from "@/types";

describe("generateTypeScript - ObjectType support", () => {
  describe("Object type hints generate correct Zod schemas", () => {
    it("should generate zod schema for simple object type", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
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
          {
            type: "assignment",
            variableName: "point",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate coordinates",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "x": z.number(), "y": z.number() })'
      );
      expect(result).toContain("{ x: number; y: number }");
    });

    it("should generate zod schema for object with different property types", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
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
          {
            type: "assignment",
            variableName: "user",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate user",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "name": z.string(), "age": z.number(), "active": z.boolean() })'
      );
      expect(result).toContain(
        "{ name: string; age: number; active: boolean }"
      );
    });

    it("should generate zod schema for object with array properties", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "data",
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
          {
            type: "assignment",
            variableName: "data",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate data",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "items": z.array(z.number()), "tags": z.array(z.string()) })'
      );
      expect(result).toContain("{ items: number[]; tags: string[] }");
    });

    it("should generate zod schema for object with literal properties", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "config",
            variableType: {
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
                {
                  key: "enabled",
                  value: { type: "booleanLiteralType", value: "true" },
                },
              ],
            },
          },
          {
            type: "assignment",
            variableName: "config",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate config",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "status": z.literal("active"), "count": z.literal(42), "enabled": z.literal(true) })'
      );
      expect(result).toContain(
        '{ status: "active"; count: 42; enabled: true }'
      );
    });

    it("should generate zod schema for empty object", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "emptyObj",
            variableType: {
              type: "objectType",
              properties: [],
            },
          },
          {
            type: "assignment",
            variableName: "emptyObj",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate empty object",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain("z.object({  })");
      expect(result).toContain("{  }");
    });

    it("should generate zod schema for single property object", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "single",
            variableType: {
              type: "objectType",
              properties: [
                {
                  key: "value",
                  value: { type: "primitiveType", value: "string" },
                },
              ],
            },
          },
          {
            type: "assignment",
            variableName: "single",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate single",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain('z.object({ "value": z.string() })');
      expect(result).toContain("{ value: string }");
    });
  });
});

describe("generateTypeScript - Type Alias support", () => {
  describe("Type aliases generate correct TypeScript type definitions", () => {
    it("should generate TypeScript type alias for primitive type", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "Name",
            aliasedType: { type: "primitiveType", value: "string" },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain("type Name = string;");
    });

    it("should generate TypeScript type alias for object type", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
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
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain("type Point = { x: number; y: number };");
    });

    it("should generate TypeScript type alias for union type", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
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
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain("type StringOrNumber = string | number;");
    });

    it("should use type alias in variable type hint and generate correct zod schema", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
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
          {
            type: "typeHint",
            variableName: "coords",
            variableType: {
              type: "typeAliasVariable",
              aliasName: "Point",
            },
          },
          {
            type: "assignment",
            variableName: "coords",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate coordinates",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      // Should generate type alias definition
      expect(result).toContain("type Point = { x: number; y: number };");

      // Should use Point as return type in function signature
      expect(result).toContain("Promise<Point>");

      // Should resolve Point to zod schema
      expect(result).toContain(
        'z.object({ "x": z.number(), "y": z.number() })'
      );
    });

    it("should handle type alias used in union", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "Point",
            aliasedType: {
              type: "objectType",
              properties: [
                {
                  key: "x",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
          },
          {
            type: "typeHint",
            variableName: "data",
            variableType: {
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
          {
            type: "assignment",
            variableName: "data",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate data",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      // Should generate type alias
      expect(result).toContain("type Point = { x: number };");

      // Should use Point in union type as return type
      expect(result).toContain("Promise<string | Point>");

      // Should resolve union with Point to zod schema
      expect(result).toContain(
        'z.union([z.string(), z.object({ "x": z.number() })])'
      );
    });

    it("should handle type alias used in object property", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
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
          {
            type: "typeHint",
            variableName: "location",
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
          {
            type: "assignment",
            variableName: "location",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate location",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      // Should generate type alias
      expect(result).toContain("type Point = { x: number; y: number };");

      // Should use Point in object property type as return type
      expect(result).toContain("Promise<{ coord: Point }>");

      // Should resolve nested type alias
      expect(result).toContain(
        'z.object({ "coord": z.object({ "x": z.number(), "y": z.number() }) })'
      );
    });

    it("should handle multiple type aliases", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "Point",
            aliasedType: {
              type: "objectType",
              properties: [
                {
                  key: "x",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
          },
          {
            type: "typeAlias",
            aliasName: "Line",
            aliasedType: {
              type: "objectType",
              properties: [
                {
                  key: "length",
                  value: { type: "primitiveType", value: "number" },
                },
              ],
            },
          },
          {
            type: "typeHint",
            variableName: "shape",
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
          {
            type: "assignment",
            variableName: "shape",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate shape",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      // Should generate both type aliases
      expect(result).toContain("type Point = { x: number };");
      expect(result).toContain("type Line = { length: number };");

      // Should use both in union as return type
      expect(result).toContain("Promise<Point | Line>");
    });

    it("should generate type alias for array type", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeAlias",
            aliasName: "Numbers",
            aliasedType: {
              type: "arrayType",
              elementType: { type: "primitiveType", value: "number" },
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain("type Numbers = number[];");
    });
  });

  describe("Object properties with descriptions", () => {
    it("should generate Zod schema with .describe() for single property with description", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "url",
            variableType: {
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
          {
            type: "assignment",
            variableName: "url",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "extract url",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "hostname": z.string().describe("hostname of a url") })'
      );
    });

    it("should generate Zod schema with .describe() for multiple properties with descriptions", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "point",
            variableType: {
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
          {
            type: "assignment",
            variableName: "point",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate point",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "x": z.number().describe("x coordinate"), "y": z.number().describe("y coordinate") })'
      );
    });

    it("should handle mix of properties with and without descriptions", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "user",
            variableType: {
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
                  // No description
                },
                {
                  key: "active",
                  value: { type: "primitiveType", value: "boolean" },
                  description: "is user active",
                },
              ],
            },
          },
          {
            type: "assignment",
            variableName: "user",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate user",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "name": z.string().describe("user name"), "age": z.number(), "active": z.boolean().describe("is user active") })'
      );
    });

    it("should escape special characters in descriptions", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "data",
            variableType: {
              type: "objectType",
              properties: [
                {
                  key: "value",
                  value: { type: "primitiveType", value: "string" },
                  description: 'test "quotes" and \\backslashes\\',
                },
              ],
            },
          },
          {
            type: "assignment",
            variableName: "data",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate data",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "value": z.string().describe("test \\"quotes\\" and \\\\backslashes\\\\") })'
      );
    });

    it("should generate descriptions for array properties", () => {
      const program: ADLProgram = {
        type: "adlProgram",
        nodes: [
          {
            type: "typeHint",
            variableName: "items",
            variableType: {
              type: "objectType",
              properties: [
                {
                  key: "ids",
                  value: {
                    type: "arrayType",
                    elementType: { type: "primitiveType", value: "number" },
                  },
                  description: "list of item ids",
                },
              ],
            },
          },
          {
            type: "assignment",
            variableName: "items",
            value: {
              type: "prompt",
              segments: [
                {
                  type: "text",
                  value: "generate items",
                },
              ],
            },
          },
        ],
      };

      const result = generateTypeScript(program);

      expect(result).toContain(
        'z.object({ "ids": z.array(z.number()).describe("list of item ids") })'
      );
    });
  });
});
