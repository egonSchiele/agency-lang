import { describe, it, expect } from "vitest";
import { resolveReExports } from "./resolveReExports.js";
import type { AgencyProgram } from "../types.js";
import {
  SymbolTable,
  type FileSymbols,
  type FunctionSymbol,
  type NodeSymbol,
  type TypeSymbol,
  type ConstantSymbol,
} from "../symbolTable.js";
import type { ExportFromStatement } from "../types/exportFromStatement.js";
import type { ImportStatement } from "../types/importStatement.js";
import type { FunctionDefinition } from "../types/function.js";
import type { TypeAlias } from "../types/typeHints.js";
import type { Assignment } from "../types.js";

function table(files: Record<string, FileSymbols>): SymbolTable {
  return new SymbolTable(files);
}

function fn(opts: {
  name: string;
  exported?: boolean;
  safe?: boolean;
  reExportedFrom?: { sourceFile: string; originalName: string };
  parameters?: FunctionSymbol["parameters"];
  returnType?: FunctionSymbol["returnType"];
}): FunctionSymbol {
  return {
    kind: "function",
    name: opts.name,
    exported: opts.exported ?? true,
    safe: opts.safe ?? false,
    parameters: opts.parameters ?? [],
    returnType: opts.returnType ?? null,
    reExportedFrom: opts.reExportedFrom,
  };
}

function makeExportFromStmt(opts: {
  modulePath: string;
  body: ExportFromStatement["body"];
}): ExportFromStatement {
  return {
    type: "exportFromStatement",
    modulePath: opts.modulePath,
    isAgencyImport: true,
    body: opts.body,
  };
}

describe("resolveReExports: function form", () => {
  it("strips exportFromStatement and synthesizes import + wrapper", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["search"],
            aliases: {},
            safeNames: [],
          },
        }),
      ],
    };
    const symbolTable = table({
      [sourcePath]: {
        search: fn({
          name: "search",
          parameters: [{ type: "functionParameter", name: "query" }],
        }),
      },
      [reexporterPath]: {
        search: fn({
          name: "search",
          parameters: [{ type: "functionParameter", name: "query" }],
          reExportedFrom: { sourceFile: sourcePath, originalName: "search" },
        }),
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);

    // exportFromStatement is gone
    expect(result.nodes.find((n) => n.type === "exportFromStatement")).toBeUndefined();

    // One import + one wrapper
    const imports = result.nodes.filter(
      (n) => n.type === "importStatement",
    ) as ImportStatement[];
    expect(imports).toHaveLength(1);
    expect(imports[0].modulePath).toBe("./source.agency");
    const namedImport = imports[0].importedNames[0];
    expect(namedImport.type).toBe("namedImport");
    if (namedImport.type === "namedImport") {
      expect(namedImport.importedNames).toEqual(["search"]);
      expect(namedImport.aliases).toEqual({ search: "_reexport_search" });
    }

    const fns = result.nodes.filter(
      (n) => n.type === "function",
    ) as FunctionDefinition[];
    expect(fns).toHaveLength(1);
    expect(fns[0].functionName).toBe("search");
    expect(fns[0].exported).toBe(true);
    expect(fns[0].parameters).toHaveLength(1);
    expect(fns[0].body).toHaveLength(1);
    expect(fns[0].body[0]).toMatchObject({
      type: "returnStatement",
      value: {
        type: "functionCall",
        functionName: "_reexport_search",
      },
    });
  });

  it("preserves alias", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["search"],
            aliases: { search: "wikiSearch" },
            safeNames: [],
          },
        }),
      ],
    };
    const symbolTable = table({
      [sourcePath]: { search: fn({ name: "search" }) },
      [reexporterPath]: {
        wikiSearch: fn({
          name: "wikiSearch",
          reExportedFrom: { sourceFile: sourcePath, originalName: "search" },
        }),
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);
    const fns = result.nodes.filter(
      (n) => n.type === "function",
    ) as FunctionDefinition[];
    expect(fns[0].functionName).toBe("wikiSearch");
    expect(fns[0].body[0]).toMatchObject({
      type: "returnStatement",
      value: { type: "functionCall", functionName: "_reexport_search" },
    });
  });

  it("propagates safe modifier to the wrapper", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["search"],
            aliases: {},
            safeNames: ["search"],
          },
        }),
      ],
    };
    const symbolTable = table({
      [sourcePath]: { search: fn({ name: "search", safe: false }) },
      [reexporterPath]: {
        search: fn({
          name: "search",
          safe: true,
          reExportedFrom: { sourceFile: sourcePath, originalName: "search" },
        }),
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);
    const fns = result.nodes.filter(
      (n) => n.type === "function",
    ) as FunctionDefinition[];
    expect(fns[0].safe).toBe(true);
  });
});

describe("resolveReExports: per-kind synthesis", () => {
  it("re-exported node emits an importNodeStatement and no wrapper", () => {
    // Nodes are merged wholesale via importNodeStatement; emitting a wrapper
    // graphNode would collide with the merged source node in SimpleMachine.
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["main"],
            aliases: {},
            safeNames: [],
          },
        }),
      ],
    };
    const sourceNode: NodeSymbol = {
      kind: "node",
      name: "main",
      parameters: [{ type: "functionParameter", name: "input" }],
      returnType: null,
      exported: true,
    };
    const symbolTable = table({
      [sourcePath]: { main: sourceNode },
      [reexporterPath]: {
        main: {
          ...sourceNode,
          reExportedFrom: { sourceFile: sourcePath, originalName: "main" },
        },
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);

    // No wrapper graphNode is synthesized.
    const graphNodes = result.nodes.filter((n) => n.type === "graphNode");
    expect(graphNodes).toHaveLength(0);

    // No regular importStatement either — nodes get importNodeStatement.
    const fnImports = result.nodes.filter((n) => n.type === "importStatement");
    expect(fnImports).toHaveLength(0);

    const nodeImports = result.nodes.filter(
      (n) => n.type === "importNodeStatement",
    );
    expect(nodeImports).toHaveLength(1);
    expect((nodeImports[0] as { importedNodes: string[] }).importedNodes).toEqual([
      "main",
    ]);
    expect((nodeImports[0] as { agencyFile: string }).agencyFile).toBe(
      "./source.agency",
    );
  });

  it("synthesizes a type alias for a re-exported type", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["Foo"],
            aliases: {},
            safeNames: [],
          },
        }),
      ],
    };
    const sourceType: TypeSymbol = {
      kind: "type",
      name: "Foo",
      exported: true,
      aliasedType: { type: "primitiveType", value: "string" },
    };
    const symbolTable = table({
      [sourcePath]: { Foo: sourceType },
      [reexporterPath]: {
        Foo: {
          ...sourceType,
          reExportedFrom: { sourceFile: sourcePath, originalName: "Foo" },
        },
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);
    const aliases = result.nodes.filter(
      (n) => n.type === "typeAlias",
    ) as TypeAlias[];
    expect(aliases).toHaveLength(1);
    expect(aliases[0].aliasName).toBe("Foo");
    expect(aliases[0].exported).toBe(true);
    expect(aliases[0].aliasedType).toEqual({
      type: "typeAliasVariable",
      aliasName: "_reexport_Foo",
    });
  });

  it("synthesizes a constant binding for a re-exported static const", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["PROMPT"],
            aliases: {},
            safeNames: [],
          },
        }),
      ],
    };
    const sourceConst: ConstantSymbol = {
      kind: "constant",
      name: "PROMPT",
      exported: true,
    };
    const symbolTable = table({
      [sourcePath]: { PROMPT: sourceConst },
      [reexporterPath]: {
        PROMPT: {
          ...sourceConst,
          reExportedFrom: { sourceFile: sourcePath, originalName: "PROMPT" },
        },
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);
    const assigns = result.nodes.filter(
      (n) => n.type === "assignment",
    ) as Assignment[];
    expect(assigns).toHaveLength(1);
    expect(assigns[0].variableName).toBe("PROMPT");
    expect(assigns[0].static).toBe(true);
    expect(assigns[0].exported).toBe(true);
    expect(assigns[0].value).toMatchObject({
      type: "variableName",
      value: "_reexport_PROMPT",
    });
  });
});

describe("resolveReExports: coalescing and star", () => {
  it("coalesces multiple named re-exports from the same source into one import", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["foo"],
            aliases: {},
            safeNames: [],
          },
        }),
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["bar"],
            aliases: {},
            safeNames: [],
          },
        }),
      ],
    };
    const symbolTable = table({
      [sourcePath]: {
        foo: fn({ name: "foo" }),
        bar: fn({ name: "bar" }),
      },
      [reexporterPath]: {
        foo: fn({
          name: "foo",
          reExportedFrom: { sourceFile: sourcePath, originalName: "foo" },
        }),
        bar: fn({
          name: "bar",
          reExportedFrom: { sourceFile: sourcePath, originalName: "bar" },
        }),
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);
    const imports = result.nodes.filter(
      (n) => n.type === "importStatement",
    ) as ImportStatement[];
    expect(imports).toHaveLength(1);
    const namedImport = imports[0].importedNames[0];
    if (namedImport.type === "namedImport") {
      expect(namedImport.importedNames.sort()).toEqual(["bar", "foo"]);
    }
  });

  it("expands star re-export using all source-side exports (via FileSymbols)", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: { kind: "starExport" },
        }),
      ],
    };
    const symbolTable = table({
      [sourcePath]: {
        foo: fn({ name: "foo" }),
        bar: fn({ name: "bar" }),
      },
      [reexporterPath]: {
        foo: fn({
          name: "foo",
          reExportedFrom: { sourceFile: sourcePath, originalName: "foo" },
        }),
        bar: fn({
          name: "bar",
          reExportedFrom: { sourceFile: sourcePath, originalName: "bar" },
        }),
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);
    const fns = result.nodes.filter(
      (n) => n.type === "function",
    ) as FunctionDefinition[];
    const names = fns.map((f) => f.functionName).sort();
    expect(names).toEqual(["bar", "foo"]);
  });
});
