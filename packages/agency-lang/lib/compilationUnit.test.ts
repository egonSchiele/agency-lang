import { describe, it, expect } from "vitest";
import { buildCompilationUnit, GLOBAL_SCOPE_KEY } from "./compilationUnit.js";
import type { AgencyProgram } from "./types.js";

describe("buildCompilationUnit", () => {
  it("collects function definitions", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "function",
          functionName: "greet",
          parameters: [],
          body: [],
        },
      ],
    };

    const info = buildCompilationUnit(program);
    expect(Object.keys(info.functionDefinitions)).toEqual(["greet"]);
    expect(info.functionDefinitions["greet"].functionName).toBe("greet");
  });

  it("collects type aliases at global scope", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "typeAlias",
          aliasName: "Name",
          aliasedType: { type: "primitiveType", value: "string" },
        },
      ],
    };
    const info = buildCompilationUnit(program);
    expect(info.typeAliases.get(GLOBAL_SCOPE_KEY)).toEqual({
      Name: { type: "primitiveType", value: "string" },
    });
  });

  it("collects type aliases inside a graph node body", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "graphNode",
          nodeName: "start",
          parameters: [],
          body: [
            {
              type: "typeAlias",
              aliasName: "LocalType",
              aliasedType: { type: "primitiveType", value: "number" },
            },
          ],
        },
      ],
    };
    const info = buildCompilationUnit(program);
    expect(info.typeAliases.get("node:start")).toEqual({
      LocalType: { type: "primitiveType", value: "number" },
    });
    expect(info.typeAliases.get(GLOBAL_SCOPE_KEY)?.["LocalType"]).toBeUndefined();
  });

  it("visibleIn merges scope with global (scope overrides)", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "typeAlias",
          aliasName: "T",
          aliasedType: { type: "primitiveType", value: "string" },
        },
        {
          type: "function",
          functionName: "fn",
          parameters: [],
          body: [
            {
              type: "typeAlias",
              aliasName: "T",
              aliasedType: { type: "primitiveType", value: "number" },
            },
          ],
        },
      ],
    };
    const info = buildCompilationUnit(program);
    const visible = info.typeAliases.visibleIn("function:fn");
    // Function-scoped T overrides global T
    expect(visible["T"]).toEqual({ type: "primitiveType", value: "number" });
  });

  it("collects graph nodes", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "graphNode",
          nodeName: "start",
          parameters: [],
          body: [],
        },
      ],
    };
    const info = buildCompilationUnit(program);
    expect(info.graphNodes).toHaveLength(1);
    expect(info.graphNodes[0].nodeName).toBe("start");
  });

  it("collects import statements by type", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "importNodeStatement",
          agencyFile: "./other.agency",
          importedNodes: ["nodeA"],
        },
        {
          type: "importStatement",
          modulePath: "./utils.ts",
          importedNames: [
            {
              type: "namedImport",
              importedNames: ["helper"],
              safeNames: ["helper"],
              aliases: {},
            },
          ],
          isAgencyImport: false,
        },
      ],
    };
    const info = buildCompilationUnit(program);
    expect(info.importedNodes).toHaveLength(1);
    expect(info.importStatements).toHaveLength(1);
  });

  it("collects all metadata in a single pass", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "typeAlias",
          aliasName: "Color",
          aliasedType: { type: "primitiveType", value: "string" },
        },
        {
          type: "function",
          functionName: "doStuff",
          parameters: [],
          body: [],
        },
        {
          type: "graphNode",
          nodeName: "main",
          parameters: [],
          body: [],
        },
      ],
    };
    const info = buildCompilationUnit(program);
    expect(Object.keys(info.functionDefinitions)).toEqual(["doStuff"]);
    expect(Object.keys(info.typeAliases.get(GLOBAL_SCOPE_KEY) ?? {})).toEqual(["Color"]);
    expect(info.graphNodes).toHaveLength(1);
  });

  it("returns references to the original AST nodes", () => {
    const funcNode = {
      type: "function" as const,
      functionName: "test",
      parameters: [],
      body: [],
    };
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [funcNode],
    };
    const info = buildCompilationUnit(program);
    expect(info.functionDefinitions["test"]).toBe(funcNode);
  });

  it("registers safe class methods in safeFunctions", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "classDefinition",
          className: "Math",
          fields: [{ type: "classField", name: "x", typeHint: { type: "primitiveType", value: "number" } }],
          methods: [
            {
              type: "classMethod",
              name: "add",
              parameters: [],
              body: [],
              returnType: { type: "primitiveType", value: "number" },
              safe: true,
            },
            {
              type: "classMethod",
              name: "save",
              parameters: [],
              body: [],
              returnType: { type: "primitiveType", value: "number" },
            },
          ],
        },
      ],
    };
    const info = buildCompilationUnit(program);
    expect(info.safeFunctions["Math.add"]).toBe(true);
    expect(info.safeFunctions["Math.save"]).toBeUndefined();
  });
});
