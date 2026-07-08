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

  it("rejects 'safe' modifier on an imported node", () => {
    // `safe` is meaningful only for functions; nodes have no safe flag.
    // Silently dropping the modifier would mislead the user.
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        {
          type: "importStatement",
          modulePath: "./other.agency",
          isAgencyImport: true,
          importedNames: [
            {
              type: "namedImport",
              importedNames: ["greet"],
              safeNames: ["greet"],
              aliases: {},
            },
          ],
        },
      ],
    };
    const symbolTable = table({
      "/project/other.agency": { greet: nodeSym("greet") },
    });
    expect(() =>
      resolveImports(program, symbolTable, "/project/main.agency"),
    ).toThrow(/'safe' modifier cannot be applied to node 'greet'/);
  });

  // Test-only imports: `import test { ... }`
  function testImport(names: string[], modulePath: string): ImportStatement {
    return { ...makeImportStatement(names, modulePath), testOnly: true };
  }

  it("import test bypasses the export check for functions in test mode", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [testImport(["helper"], "./utils.agency")],
    };
    const symbolTable = table({
      "/project/utils.agency": { helper: fn("helper", { exported: false }) },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency", {
      allowTestImports: true,
    });
    const node = result.nodes[0] as ImportStatement;
    expect(node.type).toBe("importStatement");
    if (node.importedNames[0].type === "namedImport") {
      expect(node.importedNames[0].importedNames).toEqual(["helper"]);
    }
  });

  it("import test bypasses the export check for a non-exported type in test mode", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [testImport(["Secret"], "./types.agency")],
    };
    const symbolTable = table({
      "/project/types.agency": {
        Secret: {
          kind: "type",
          name: "Secret",
          exported: false,
          aliasedType: { type: "primitiveType", value: "string" },
        },
      },
    });
    const result = resolveImports(program, symbolTable, "/project/main.agency", {
      allowTestImports: true,
    });
    expect((result.nodes[0] as ImportStatement).type).toBe("importStatement");
  });

  it("import test is rejected outside test mode (default is deny)", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [testImport(["helper"], "./utils.agency")],
    };
    const symbolTable = table({
      "/project/utils.agency": { helper: fn("helper", { exported: false }) },
    });
    // 3-arg call: no opts at all — pins the default-deny security property.
    expect(() =>
      resolveImports(program, symbolTable, "/project/main.agency"),
    ).toThrow(/only allowed under the test harness/);
  });

  it("import test is rejected for pkg:: imports even in test mode", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [testImport(["helper"], "pkg::some-package")],
    };
    const symbolTable = table({}); // empty: the gate must fire before symbol lookup
    expect(() =>
      resolveImports(program, symbolTable, "/project/main.agency", {
        allowTestImports: true,
      }),
    ).toThrow(/cannot be used with pkg:: imports/);
  });

  it("import test is rejected for TypeScript imports even in test mode", () => {
    // Non-Agency paths skip the resolver entirely for plain imports; the
    // testOnly gate must still fire so the keyword never silently no-ops.
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [testImport(["helper"], "./foo.ts")],
    };
    const symbolTable = table({});
    expect(() =>
      resolveImports(program, symbolTable, "/project/main.agency", {
        allowTestImports: true,
      }),
    ).toThrow(/cannot be used with TypeScript or npm imports/);
  });

  it("import test is rejected for bare npm imports outside test mode too", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [testImport(["debounce"], "lodash")],
    };
    const symbolTable = table({});
    expect(() =>
      resolveImports(program, symbolTable, "/project/main.agency"),
    ).toThrow(/cannot be used with TypeScript or npm imports/);
  });
});
