import { describe, it, expect } from "vitest";
import { collectProgramInfo } from "./programInfo.js";
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

  it("collects type aliases", () => {
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
    expect(info.typeAliases).toEqual({
      Name: { type: "primitiveType", value: "string" },
    });
  });

  it("collects type hints", () => {
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
    expect(info.typeHints).toEqual({
      x: { type: "primitiveType", value: "number" },
    });
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
          importedTools: ["myTool"],
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
    expect(Object.keys(info.typeAliases)).toEqual(["Color"]);
    expect(Object.keys(info.typeHints)).toEqual(["x"]);
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
