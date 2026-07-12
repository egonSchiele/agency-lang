import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import os from "os";
import path from "path";
import { buildCompilationUnit, GLOBAL_SCOPE_KEY } from "./compilationUnit.js";
import { SymbolTable } from "./symbolTable.js";
import { parseAgency } from "./parser.js";
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
      Name: { body: { type: "primitiveType", value: "string" } },
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
      LocalType: { body: { type: "primitiveType", value: "number" } },
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
    expect(visible["T"]).toEqual({ body: { type: "primitiveType", value: "number" } });
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

});

describe("buildCompilationUnit: marker registries", () => {
  const unitFromSource = (src: string, file?: string) => {
    const parsed = parseAgency(src, {}, false);
    if (!parsed.success) throw new Error(parsed.message ?? "parse failed");
    const symbolTable = file ? SymbolTable.build(file) : undefined;
    return buildCompilationUnit(parsed.result, symbolTable, file);
  };

  it("registers a local destructive def", () => {
    const unit = unitFromSource("destructive def rm(p: string) { return 1 }");
    expect(unit.destructiveFunctions["rm"]).toBe(true);
    expect(unit.idempotentFunctions["rm"]).toBeUndefined();
  });

  it("registers a local idempotent def", () => {
    const unit = unitFromSource("idempotent def f(): number { return 1 }");
    expect(unit.idempotentFunctions["f"]).toBe(true);
    expect(unit.destructiveFunctions["f"]).toBeUndefined();
  });

  it("registers a destructive import", () => {
    const unit = unitFromSource(
      'import { destructive rm } from "./t.js"\nnode main() { return 1 }',
    );
    expect(unit.destructiveFunctions["rm"]).toBe(true);
  });

  it("does not populate safeFunctions anymore", () => {
    const unit = unitFromSource("safe def f(): number { return 1 }");
    expect(Object.keys(unit.safeFunctions)).toHaveLength(0);
  });

  it("propagates destructive through a re-export chain", () => {
    // A defines `destructive def rm`; B re-exports it; C imports from B.
    // Pins the symbol-copy path (mergeOne) that carries markers across
    // re-exports.
    const suffix = "destructive-reexport";
    const aPath = path.join(os.tmpdir(), `cu-a-${suffix}.agency`);
    const bPath = path.join(os.tmpdir(), `cu-b-${suffix}.agency`);
    const cPath = path.join(os.tmpdir(), `cu-c-${suffix}.agency`);
    writeFileSync(aPath, `export destructive def rm(p: string) { return 1 }`);
    writeFileSync(bPath, `export { rm } from "${aPath}"`);
    writeFileSync(cPath, `import { rm } from "${bPath}"\nnode main() { rm("x") }`);
    try {
      const src = `import { rm } from "${bPath}"\nnode main() { rm("x") }`;
      const parsed = parseAgency(src, {}, false);
      if (!parsed.success) throw new Error("parse failed");
      const symbolTable = SymbolTable.build(cPath);
      const unit = buildCompilationUnit(parsed.result, symbolTable, cPath);
      expect(unit.destructiveFunctions["rm"]).toBe(true);
    } finally {
      for (const p of [aPath, bPath, cPath]) {
        try {
          unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  });
});
