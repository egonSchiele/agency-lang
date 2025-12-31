import { describe, it, expect } from "vitest";
import { generateTypeScript } from "./adlTypescript";
import { ADLProgram } from "@/types";

describe("generateTypeScript - ObjectType support", () => {
  describe("Object type hints generate correct Zod schemas", () => {
    it("should generate zod schema for simple object type", () => {
      const program: ADLProgram = {
        type: "program",
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

      expect(result).toContain('z.object({ "x": z.number(), "y": z.number() })');
      expect(result).toContain("{ x: number; y: number }");
    });

    it("should generate zod schema for object with different property types", () => {
      const program: ADLProgram = {
        type: "program",
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
      expect(result).toContain("{ name: string; age: number; active: boolean }");
    });

    it("should generate zod schema for object with array properties", () => {
      const program: ADLProgram = {
        type: "program",
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
        type: "program",
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
        type: "program",
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
        type: "program",
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
