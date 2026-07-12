import { describe, it, expect } from "vitest";
import { resolveReExports } from "./resolveReExports.js";
import type { AgencyNode, AgencyProgram } from "../types.js";
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
  markers?: FunctionSymbol["markers"];
  reExportedFrom?: { sourceFile: string; originalName: string };
  parameters?: FunctionSymbol["parameters"];
  returnType?: FunctionSymbol["returnType"];
}): FunctionSymbol {
  return {
    kind: "function",
    name: opts.name,
    exported: opts.exported ?? true,
    parameters: opts.parameters ?? [],
    returnType: opts.returnType ?? null,
    reExportedFrom: opts.reExportedFrom,
    markers: opts.markers,
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

  it("propagates a destructive marker to the wrapper", () => {
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
            destructiveNames: ["search"],
          },
        }),
      ],
    };
    // The re-exporter's symbol carries the marker (symbolTable's mergeOne
    // folds `destructiveNames` onto it); resolveReExports copies it to the
    // synthesized wrapper.
    const symbolTable = table({
      [sourcePath]: { search: fn({ name: "search" }) },
      [reexporterPath]: {
        search: fn({
          name: "search",
          markers: { destructive: true },
          reExportedFrom: { sourceFile: sourcePath, originalName: "search" },
        }),
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);
    const fns = result.nodes.filter(
      (n) => n.type === "function",
    ) as FunctionDefinition[];
    expect(fns[0].markers?.destructive).toBe(true);
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
          },
        }),
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["bar"],
            aliases: {},
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

describe("resolveReExports: leading preamble ordering", () => {
  it("keeps a leading @module doc comment and imports ahead of synthesized nodes", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    const userImport = {
      type: "importStatement",
      modulePath: "./other.agency",
      isAgencyImport: true,
      importedNames: [],
    } as unknown as AgencyNode;
    const moduleDoc = {
      type: "multiLineComment",
      content: "\n  module docs\n",
      isDoc: true,
      isModuleDoc: true,
    } as unknown as AgencyNode;
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        userImport,
        moduleDoc,
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["search"],
            aliases: {},
          },
        }),
      ],
    };
    const symbolTable = table({
      [sourcePath]: { search: fn({ name: "search" }) },
      [reexporterPath]: {
        search: fn({
          name: "search",
          reExportedFrom: { sourceFile: sourcePath, originalName: "search" },
        }),
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);

    const docIdx = result.nodes.findIndex((n) => n.type === "multiLineComment");
    const wrapperIdx = result.nodes.findIndex((n) => n.type === "function");
    const synthImportIdx = result.nodes.findIndex(
      (n) =>
        n.type === "importStatement" &&
        (n as ImportStatement).modulePath === "./source.agency",
    );

    // The module doc must precede every synthesized node so the
    // preprocessor's "module doc must precede code" check still passes.
    expect(docIdx).toBeGreaterThanOrEqual(0);
    expect(wrapperIdx).toBeGreaterThan(docIdx);
    expect(synthImportIdx).toBeGreaterThan(docIdx);

    // Nothing non-preamble appears before the module doc.
    const preamble = new Set([
      "comment",
      "newLine",
      "multiLineComment",
      "importStatement",
      "importNodeStatement",
    ]);
    expect(
      result.nodes.slice(0, docIdx).every((n) => preamble.has(n.type)),
    ).toBe(true);
  });

  it("does not split a regular doc comment from the declaration it documents", () => {
    const sourcePath = "/project/source.agency";
    const reexporterPath = "/project/reexporter.agency";
    // A non-`@module` doc comment binds to the next declaration. Synthesized
    // re-export nodes must not be inserted between them.
    const docComment = {
      type: "multiLineComment",
      content: " docs for foo ",
      isDoc: true,
      isModuleDoc: false,
    } as unknown as AgencyNode;
    const fooDef = {
      type: "function",
      functionName: "foo",
      exported: true,
      parameters: [],
      body: [],
    } as unknown as AgencyNode;
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [
        docComment,
        fooDef,
        makeExportFromStmt({
          modulePath: "./source.agency",
          body: {
            kind: "namedExport",
            names: ["search"],
            aliases: {},
          },
        }),
      ],
    };
    const symbolTable = table({
      [sourcePath]: { search: fn({ name: "search" }) },
      [reexporterPath]: {
        foo: fn({ name: "foo" }),
        search: fn({
          name: "search",
          reExportedFrom: { sourceFile: sourcePath, originalName: "search" },
        }),
      },
    });

    const result = resolveReExports(program, symbolTable, reexporterPath);

    // The doc comment is immediately followed by `foo` (the declaration it
    // documents) — nothing synthesized was spliced between them.
    const docIdx = result.nodes.findIndex((n) => n.type === "multiLineComment");
    expect(docIdx).toBeGreaterThanOrEqual(0);
    expect(result.nodes[docIdx + 1]).toMatchObject({
      type: "function",
      functionName: "foo",
    });
  });
});
