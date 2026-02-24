import { describe, it, expect } from "vitest";
import { generateDeclarations } from "./declarationGenerator.js";
import { AgencyProgram } from "../types.js";

describe("DeclarationGenerator", () => {
  it("should generate declarations for a def function", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          body: [],
          returnType: { type: "primitiveType", value: "number" },
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).toContain(
      "export function add(args: [number, number], __metadata?: Record<string, any>): Promise<number>;",
    );
    expect(result).toContain('export const __addTool:');
    expect(result).toContain('export const __addToolParams: ["x", "y"];');
  });

  it("should generate declarations for a graph node", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "graphNode",
          nodeName: "greet",
          parameters: [
            {
              type: "functionParameter",
              name: "name",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          body: [],
          returnType: { type: "primitiveType", value: "string" },
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).toContain(
      "export function greet(name: string, options?: NodeOptions): Promise<ReturnObject<string>>;",
    );
    expect(result).toContain("export interface ReturnObject<T = any>");
    expect(result).toContain("export interface NodeOptions");
    expect(result).toContain("export interface TokenStats");
    expect(result).toContain("export default graph;");
  });

  it("should generate declarations for type aliases", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "typeAlias",
          aliasName: "UserId",
          aliasedType: { type: "primitiveType", value: "string" },
        },
        {
          type: "typeAlias",
          aliasName: "Status",
          aliasedType: {
            type: "unionType",
            types: [
              { type: "stringLiteralType", value: "active" },
              { type: "stringLiteralType", value: "inactive" },
            ],
          },
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).toContain("export type UserId = string;");
    expect(result).toContain(
      'export type Status = "active" | "inactive";',
    );
  });

  it("should handle functions without type hints", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "function",
          functionName: "doStuff",
          parameters: [
            { type: "functionParameter", name: "input" },
          ],
          body: [],
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).toContain(
      "export function doStuff(args: [any], __metadata?: Record<string, any>): Promise<any>;",
    );
  });

  it("should handle graph nodes without return type", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "graphNode",
          nodeName: "main",
          parameters: [],
          body: [],
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).toContain(
      "export function main(options?: NodeOptions): Promise<ReturnObject<undefined>>;",
    );
  });

  it("should handle complex parameter types", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "function",
          functionName: "process",
          parameters: [
            {
              type: "functionParameter",
              name: "items",
              typeHint: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "number" },
              },
            },
            {
              type: "functionParameter",
              name: "mode",
              typeHint: {
                type: "unionType",
                types: [
                  { type: "stringLiteralType", value: "fast" },
                  { type: "stringLiteralType", value: "slow" },
                ],
              },
            },
          ],
          body: [],
          returnType: {
            type: "objectType",
            properties: [
              {
                key: "count",
                value: { type: "primitiveType", value: "number" },
              },
              {
                key: "result",
                value: { type: "primitiveType", value: "string" },
              },
            ],
          },
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).toContain(
      'export function process(args: [number[], "fast" | "slow"], __metadata?: Record<string, any>): Promise<{ count: number; result: string }>;',
    );
  });

  it("should include docstrings as JSDoc", () => {
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
          docString: { type: "docString", value: "Greets a person by name" },
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).toContain("/** Greets a person by name */");
  });

  it("should handle imports", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "importStatement",
          importedNames: [
            { type: "namedImport", importedNames: ["foo", "bar"] },
          ],
          modulePath: "./utils.js",
        },
        {
          type: "importNodeStatement",
          importedNodes: ["analyzeData"],
          agencyFile: "./analyzer.agency",
        },
        {
          type: "importToolStatement",
          importedTools: ["search"],
          agencyFile: "./tools.agency",
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).toContain('import { foo, bar } from "./utils.js";');
    expect(result).toContain(
      'import { analyzeData } from "./analyzer.js";',
    );
    expect(result).toContain(
      'import { __searchTool, __searchToolParams } from "./tools.js";',
    );
  });

  it("should not emit ReturnObject/NodeOptions/default export when there are no graph nodes", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "function",
          functionName: "add",
          parameters: [],
          body: [],
          returnType: { type: "primitiveType", value: "number" },
        },
      ],
    };

    const result = generateDeclarations(program);
    expect(result).not.toContain("ReturnObject");
    expect(result).not.toContain("NodeOptions");
    expect(result).not.toContain("export default");
  });

  it("should handle a full program with multiple features", () => {
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
          functionName: "formatName",
          parameters: [
            {
              type: "functionParameter",
              name: "name",
              typeHint: { type: "typeAliasVariable", aliasName: "Name" },
            },
          ],
          body: [],
          returnType: { type: "primitiveType", value: "string" },
          docString: { type: "docString", value: "Formats a name" },
        },
        {
          type: "graphNode",
          nodeName: "main",
          parameters: [
            {
              type: "functionParameter",
              name: "input",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          body: [],
          returnType: { type: "primitiveType", value: "string" },
        },
      ],
    };

    const result = generateDeclarations(program);
    // Has type alias
    expect(result).toContain("export type Name = string;");
    // Has function with docstring
    expect(result).toContain("/** Formats a name */");
    expect(result).toContain(
      "export function formatName(args: [Name], __metadata?: Record<string, any>): Promise<string>;",
    );
    // Has node
    expect(result).toContain(
      "export function main(input: string, options?: NodeOptions): Promise<ReturnObject<string>>;",
    );
    // Has tool definition
    expect(result).toContain("export const __formatNameTool:");
    // Has default export
    expect(result).toContain("export default graph;");
  });
});
