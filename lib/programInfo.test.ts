import { describe, it, expect } from "vitest";
import { collectProgramInfo, lookupType, getVisibleTypes, GLOBAL_SCOPE_KEY } from "./programInfo.js";
import type { AgencyProgram } from "./types.js";

describe("collectProgramInfo", () => {
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

    const info = collectProgramInfo(program);
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
    const info = collectProgramInfo(program);
    expect(info.typeAliases[GLOBAL_SCOPE_KEY]).toEqual({
      Name: { type: "primitiveType", value: "string" },
    });
  });

  it("collects type hints at global scope", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "typeHint",
          variableName: "x",
          variableType: { type: "primitiveType", value: "number" },
        },
      ],
    };
    const info = collectProgramInfo(program);
    expect(info.typeHints[GLOBAL_SCOPE_KEY]).toEqual({
      x: { type: "primitiveType", value: "number" },
    });
  });

  it("collects type hints inside a function body", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "function",
          functionName: "greet",
          parameters: [],
          body: [
            {
              type: "typeHint",
              variableName: "y",
              variableType: { type: "primitiveType", value: "string" },
            },
          ],
        },
      ],
    };
    const info = collectProgramInfo(program);
    expect(info.typeHints["function:greet"]).toEqual({
      y: { type: "primitiveType", value: "string" },
    });
    // Should not appear at global scope
    expect(info.typeHints[GLOBAL_SCOPE_KEY]["y"]).toBeUndefined();
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
    const info = collectProgramInfo(program);
    expect(info.typeAliases["node:start"]).toEqual({
      LocalType: { type: "primitiveType", value: "number" },
    });
    expect(info.typeAliases[GLOBAL_SCOPE_KEY]["LocalType"]).toBeUndefined();
  });

  it("scoped type hints do not leak between functions", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "function",
          functionName: "a",
          parameters: [],
          body: [
            {
              type: "typeHint",
              variableName: "foo",
              variableType: { type: "primitiveType", value: "number" },
            },
          ],
        },
        {
          type: "function",
          functionName: "b",
          parameters: [],
          body: [
            {
              type: "typeHint",
              variableName: "foo",
              variableType: { type: "primitiveType", value: "string" },
            },
          ],
        },
      ],
    };
    const info = collectProgramInfo(program);

    // Each function has its own type hint for foo
    expect(lookupType(info.typeHints, "function:a", "foo")).toEqual({
      type: "primitiveType",
      value: "number",
    });
    expect(lookupType(info.typeHints, "function:b", "foo")).toEqual({
      type: "primitiveType",
      value: "string",
    });
  });

  it("lookupType falls back to global scope", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "typeHint",
          variableName: "x",
          variableType: { type: "primitiveType", value: "number" },
        },
        {
          type: "function",
          functionName: "greet",
          parameters: [],
          body: [],
        },
      ],
    };
    const info = collectProgramInfo(program);

    // Global hint is visible from function scope via fallback
    expect(lookupType(info.typeHints, "function:greet", "x")).toEqual({
      type: "primitiveType",
      value: "number",
    });
  });

  it("getVisibleTypes merges scope with global (scope overrides)", () => {
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
    const info = collectProgramInfo(program);
    const visible = getVisibleTypes(info.typeAliases, "function:fn");
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
    const info = collectProgramInfo(program);
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
          type: "importToolStatement",
          agencyFile: "./tools.ts",
          importedTools: [{ type: "namedImport", importedNames: ["myTool"], safeNames: [] }],
        },
        {
          type: "importStatement",
          modulePath: "./utils.ts",
          importedNames: [
            {
              type: "namedImport",
              importedNames: ["helper"],
              safeNames: ["helper"],
            },
          ],
        },
      ],
    };
    const info = collectProgramInfo(program);
    expect(info.importedNodes).toHaveLength(1);
    expect(info.importedTools).toHaveLength(1);
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
          type: "typeHint",
          variableName: "x",
          variableType: { type: "primitiveType", value: "number" },
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
    const info = collectProgramInfo(program);
    expect(Object.keys(info.functionDefinitions)).toEqual(["doStuff"]);
    expect(Object.keys(info.typeAliases[GLOBAL_SCOPE_KEY])).toEqual(["Color"]);
    expect(Object.keys(info.typeHints[GLOBAL_SCOPE_KEY])).toEqual(["x"]);
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
    const info = collectProgramInfo(program);
    expect(info.functionDefinitions["test"]).toBe(funcNode);
  });
});
