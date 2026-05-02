import { describe, it, expect } from "vitest";
import { resolveImports } from "./importResolver.js";
import type { AgencyProgram } from "../types.js";
import {
  SymbolTable,
  type FileSymbols,
  type FunctionSymbol,
  type NodeSymbol,
  type TypeSymbol,
} from "../symbolTable.js";

function table(files: Record<string, FileSymbols>): SymbolTable {
  return new SymbolTable(files);
}

function fn(name: string, opts: { exported?: boolean; safe?: boolean } = {}): FunctionSymbol {
  return {
    kind: "function",
    name,
    exported: opts.exported ?? false,
    safe: opts.safe ?? false,
    parameters: [],
    returnType: null,
  };
}

function nodeSym(name: string): NodeSymbol {
  return { kind: "node", name, parameters: [], returnType: null };
}

function typeSym(name: string): TypeSymbol {
  return {
    kind: "type",
    name,
    exported: true,
    aliasedType: { type: "primitiveType", value: "string" },
  };
}
import type {
  ImportStatement,
  ImportNodeStatement,
} from "../types/importStatement.js";

function makeImportStatement(
  names: string[],
  modulePath: string,
): ImportStatement {
  return {
    type: "importStatement",
    importedNames: [
      { type: "namedImport", importedNames: names, safeNames: [], aliases: {} },
    ],
    modulePath,
    isAgencyImport: modulePath.endsWith(".agency"),
  };
}

describe("resolveImports", () => {
  it("rewrites node imports to ImportNodeStatement", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["greet"], "./other.agency")],
    };
    const symbolTable = table({
      "/project/other.agency": {
        greet: nodeSym("greet"),
      },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0] as ImportNodeStatement;
    expect(node.type).toBe("importNodeStatement");
    expect(node.importedNodes).toEqual(["greet"]);
    expect(node.agencyFile).toBe("./other.agency");
  });

  it("rewrites function imports to ImportStatement", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["add"], "./utils.agency")],
    };
    const symbolTable = table({
      "/project/utils.agency": {
        add: fn("add", { exported: true }),
      },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0] as ImportStatement;
    expect(node.type).toBe("importStatement");
    expect(node.importedNames[0].type).toBe("namedImport");
    if (node.importedNames[0].type === "namedImport") {
      expect(node.importedNames[0].importedNames).toEqual(["add"]);
    }
  });

  it("keeps type imports as ImportStatement", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["Config"], "./types.agency")],
    };
    const symbolTable = table({
      "/project/types.agency": {
        Config: typeSym("Config"),
      },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0] as ImportStatement;
    expect(node.type).toBe("importStatement");
    expect(node.importedNames[0].type).toBe("namedImport");
    if (node.importedNames[0].type === "namedImport") {
      expect(node.importedNames[0].importedNames).toEqual(["Config"]);
    }
  });

  it("splits mixed imports: nodes separate, functions+types combined", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeImportStatement(["greet", "add", "Config"], "./mixed.agency"),
      ],
    };
    const symbolTable = table({
      "/project/mixed.agency": {
        greet: nodeSym("greet"),
        add: fn("add", { exported: true }),
        Config: typeSym("Config"),
      },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    // Nodes get a separate ImportNodeStatement, functions+types share an ImportStatement
    expect(result.nodes).toHaveLength(2);

    const nodeImport = result.nodes[0] as ImportNodeStatement;
    expect(nodeImport.type).toBe("importNodeStatement");
    expect(nodeImport.importedNodes).toEqual(["greet"]);

    const importStmt = result.nodes[1] as ImportStatement;
    expect(importStmt.type).toBe("importStatement");
    if (importStmt.importedNames[0].type === "namedImport") {
      expect(importStmt.importedNames[0].importedNames).toEqual(["add", "Config"]);
    }
  });

  it("carries aliases through to ImportStatement for functions", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "importStatement",
          importedNames: [
            {
              type: "namedImport",
              importedNames: ["add"],
              safeNames: [],
              aliases: { add: "plus" },
            },
          ],
          modulePath: "./utils.agency",
          isAgencyImport: true,
        },
      ],
    };
    const symbolTable = table({
      "/project/utils.agency": {
        add: fn("add", { exported: true }),
      },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0] as ImportStatement;
    expect(node.type).toBe("importStatement");
    if (node.importedNames[0].type === "namedImport") {
      expect(node.importedNames[0].aliases).toEqual({ add: "plus" });
    }
  });

  it("carries aliases through to ImportStatement for types", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "importStatement",
          importedNames: [
            {
              type: "namedImport",
              importedNames: ["Config"],
              safeNames: [],
              aliases: { Config: "AppConfig" },
            },
          ],
          modulePath: "./types.agency",
          isAgencyImport: true,
        },
      ],
    };
    const symbolTable = table({
      "/project/types.agency": {
        Config: typeSym("Config"),
      },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0] as ImportStatement;
    expect(node.type).toBe("importStatement");
    expect(node.importedNames[0]).toEqual({
      type: "namedImport",
      importedNames: ["Config"],
      safeNames: [],
      aliases: { Config: "AppConfig" },
    });
  });

  it("carries aliases through mixed import splits", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "importStatement",
          importedNames: [
            {
              type: "namedImport",
              importedNames: ["add", "Config"],
              safeNames: [],
              aliases: { add: "plus", Config: "AppConfig" },
            },
          ],
          modulePath: "./mixed.agency",
          isAgencyImport: true,
        },
      ],
    };
    const symbolTable = table({
      "/project/mixed.agency": {
        add: fn("add", { exported: true }),
        Config: typeSym("Config"),
      },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency");
    // Functions and types are now combined in a single ImportStatement
    expect(result.nodes).toHaveLength(1);

    const importStmt = result.nodes[0] as ImportStatement;
    expect(importStmt.type).toBe("importStatement");
    if (importStmt.importedNames[0].type === "namedImport") {
      expect(importStmt.importedNames[0].importedNames).toEqual(["add", "Config"]);
      expect(importStmt.importedNames[0].aliases).toEqual({ add: "plus", Config: "AppConfig" });
    }
  });

  it("throws when importing a non-exported function", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["helper"], "./utils.agency")],
    };
    const symbolTable = table({
      "/project/utils.agency": {
        helper: fn("helper"),
      },
    });
    expect(() =>
      resolveImports(program, symbolTable, "/project/main.agency"),
    ).toThrow("Function 'helper' in './utils.agency' is not exported");
  });

  it("throws on undefined symbols", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [makeImportStatement(["missing"], "./other.agency")],
    };
    const symbolTable = table({
      "/project/other.agency": {},
    });
    expect(() =>
      resolveImports(program, symbolTable, "/project/main.agency"),
    ).toThrow("Symbol 'missing' is not defined in './other.agency'");
  });

  it("leaves non-.agency imports untouched", () => {
    const tsImport: ImportStatement = {
      type: "importStatement",
      importedNames: [
        { type: "namedImport", importedNames: ["foo"], safeNames: [], aliases: {} },
      ],
      modulePath: "./utils.js",
      isAgencyImport: false,
    };
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [tsImport],
    };
    const result = resolveImports(program, new SymbolTable(), "/project/main.agency");
    expect(result.nodes).toEqual([tsImport]);
  });

  it("leaves import node statements untouched", () => {
    const nodeImport: ImportNodeStatement = {
      type: "importNodeStatement",
      importedNodes: ["greet"],
      agencyFile: "./other.agency",
    };
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [nodeImport],
    };
    const result = resolveImports(program, new SymbolTable(), "/project/main.agency");
    expect(result.nodes).toEqual([nodeImport]);
  });
});
