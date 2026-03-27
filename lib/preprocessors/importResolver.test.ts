import { describe, it, expect } from "vitest";
import { resolveImports } from "./importResolver.js";
import type { AgencyProgram } from "../types.js";
import type { SymbolTable } from "../symbolTable.js";
import type {
  ImportStatement,
  ImportNodeStatement,
  ImportToolStatement,
} from "../types/importStatement.js";

function makeImportStatement(
  names: string[],
  modulePath: string,
): ImportStatement {
  return {
    type: "importStatement",
    importedNames: [
      { type: "namedImport", importedNames: names, safeNames: [] },
    ],
    modulePath,
  };
}

describe("resolveImports", () => {
  it("rewrites node imports to ImportNodeStatement", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["greet"], "./other.agency")],
    };
    const symbolTable: SymbolTable = {
      "/project/other.agency": {
        greet: { kind: "node", name: "greet" },
      },
    };
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0] as ImportNodeStatement;
    expect(node.type).toBe("importNodeStatement");
    expect(node.importedNodes).toEqual(["greet"]);
    expect(node.agencyFile).toBe("./other.agency");
  });

  it("rewrites function imports to ImportToolStatement", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["add"], "./utils.agency")],
    };
    const symbolTable: SymbolTable = {
      "/project/utils.agency": {
        add: { kind: "function", name: "add" },
      },
    };
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0] as ImportToolStatement;
    expect(node.type).toBe("importToolStatement");
    expect(node.importedTools).toEqual([{ type: "namedImport", importedNames: ["add"], safeNames: [] }]);
  });

  it("keeps type imports as ImportStatement", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["Config"], "./types.agency")],
    };
    const symbolTable: SymbolTable = {
      "/project/types.agency": {
        Config: { kind: "type", name: "Config" },
      },
    };
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0] as ImportStatement;
    expect(node.type).toBe("importStatement");
    expect(node.importedNames[0].type).toBe("namedImport");
    if (node.importedNames[0].type === "namedImport") {
      expect(node.importedNames[0].importedNames).toEqual(["Config"]);
    }
  });

  it("splits mixed imports into separate nodes", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeImportStatement(["greet", "add", "Config"], "./mixed.agency"),
      ],
    };
    const symbolTable: SymbolTable = {
      "/project/mixed.agency": {
        greet: { kind: "node", name: "greet" },
        add: { kind: "function", name: "add" },
        Config: { kind: "type", name: "Config" },
      },
    };
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(3);

    const nodeImport = result.nodes[0] as ImportNodeStatement;
    expect(nodeImport.type).toBe("importNodeStatement");
    expect(nodeImport.importedNodes).toEqual(["greet"]);

    const toolImport = result.nodes[1] as ImportToolStatement;
    expect(toolImport.type).toBe("importToolStatement");
    expect(toolImport.importedTools).toEqual([{ type: "namedImport", importedNames: ["add"], safeNames: [] }]);

    const typeImport = result.nodes[2] as ImportStatement;
    expect(typeImport.type).toBe("importStatement");
  });

  it("throws on undefined symbols", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["missing"], "./other.agency")],
    };
    const symbolTable: SymbolTable = {
      "/project/other.agency": {},
    };
    expect(() =>
      resolveImports(program, symbolTable, "/project/main.agency"),
    ).toThrow("Symbol 'missing' is not defined in './other.agency'");
  });

  it("leaves non-.agency imports untouched", () => {
    const tsImport: ImportStatement = {
      type: "importStatement",
      importedNames: [
        { type: "namedImport", importedNames: ["foo"], safeNames: [] },
      ],
      modulePath: "./utils.js",
    };
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [tsImport],
    };
    const result = resolveImports(program, {}, "/project/main.agency");
    expect(result.nodes).toEqual([tsImport]);
  });

  it("leaves import node / import tool statements untouched", () => {
    const nodeImport: ImportNodeStatement = {
      type: "importNodeStatement",
      importedNodes: ["greet"],
      agencyFile: "./other.agency",
    };
    const toolImport: ImportToolStatement = {
      type: "importToolStatement",
      importedTools: [{ type: "namedImport", importedNames: ["add"], safeNames: [] }],
      agencyFile: "./utils.agency",
    };
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [nodeImport, toolImport],
    };
    const result = resolveImports(program, {}, "/project/main.agency");
    expect(result.nodes).toEqual([nodeImport, toolImport]);
  });
});
