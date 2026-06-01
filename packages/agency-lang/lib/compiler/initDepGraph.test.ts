import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { AgencyProgram } from "../types.js";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildInitDepGraph, makeKey } from "./initDepGraph.js";

function parse(source: string): AgencyProgram {
  const result = parseAgency(source, {}, false);
  if (!result.success) {
    throw new Error(
      `parse failed: ${result.message ?? JSON.stringify(result)}`,
    );
  }
  return result.result;
}

/**
 * Helper: write a multi-file fixture under a temp dir and return
 * (entry path, parsed programs by abs path, symbol table). Caller is
 * responsible for cleanup of the returned dir.
 */
function writeFixture(
  files: Record<string, string>,
): {
  dir: string;
  programs: Record<string, AgencyProgram>;
  symbolTable: SymbolTable;
  abs: (rel: string) => string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-dep-graph-test-"));
  const programs: Record<string, AgencyProgram> = {};
  for (const [relPath, source] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, source, "utf-8");
    programs[absPath] = parse(source);
  }
  // Find the first file as entry; tests can override by passing the
  // entry explicitly to `buildInitDepGraph`.
  const entry = path.join(dir, Object.keys(files)[0]);
  const symbolTable = SymbolTable.build(entry, {});
  return {
    dir,
    programs,
    symbolTable,
    abs: (rel) => path.join(dir, rel),
  };
}

describe("buildInitDepGraph", () => {
  it("returns an empty graph for an empty module", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency": `node main() { return 1 }\n`,
    });
    try {
      const g = buildInitDepGraph(programs, symbolTable, abs("entry.agency"));
      expect(Object.keys(g.nodes)).toEqual([]);
      expect(Object.keys(g.edges)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds an edge when one same-module decl references another", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const a = "hello"\n` +
        `static const b = a + "!"\n` +
        `node main() { return b }\n`,
    });
    try {
      const g = buildInitDepGraph(programs, symbolTable, abs("entry.agency"));
      const keyA = makeKey(abs("entry.agency"), "a");
      const keyB = makeKey(abs("entry.agency"), "b");
      expect(g.nodes[keyA]).toBeDefined();
      expect(g.nodes[keyB]).toBeDefined();
      expect(g.nodes[keyA]?.kind).toBe("static");
      expect(g.edges[keyB]).toEqual([keyA]);
      expect(g.edges[keyA]).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds a cross-module edge when an import is referenced", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { barStatic } from "./bar.agency"\n` +
        `static const fooStatic = barStatic + "!"\n` +
        `node main() { return fooStatic }\n`,
      "bar.agency": `export static const barStatic = "hello"\n`,
    });
    try {
      const g = buildInitDepGraph(programs, symbolTable, abs("foo.agency"));
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(g.nodes[keyFoo]).toBeDefined();
      expect(g.nodes[keyBar]).toBeDefined();
      expect(g.edges[keyFoo]).toEqual([keyBar]);
      expect(g.edges[keyBar]).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves re-exported statics to their ultimate source module", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { barStatic } from "./reexport.agency"\n` +
        `static const fooStatic = barStatic + "!"\n` +
        `node main() { return fooStatic }\n`,
      "reexport.agency": `export { barStatic } from "./bar.agency"\n`,
      "bar.agency": `export static const barStatic = "hello"\n`,
    });
    try {
      const g = buildInitDepGraph(programs, symbolTable, abs("foo.agency"));
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      // No node should exist for the re-exporter — canonical is bar's.
      expect(g.nodes[makeKey(abs("reexport.agency"), "barStatic")]).toBeUndefined();
      expect(g.edges[keyFoo]).toEqual([keyBar]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a single node for a diamond-imported static", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `import { aStatic } from "./left.agency"\n` +
        `import { bStatic } from "./right.agency"\n` +
        `static const main_ = aStatic + bStatic\n` +
        `node main() { return main_ }\n`,
      "left.agency":
        `import { sharedStatic } from "./shared.agency"\n` +
        `export static const aStatic = sharedStatic + "L"\n`,
      "right.agency":
        `import { sharedStatic } from "./shared.agency"\n` +
        `export static const bStatic = sharedStatic + "R"\n`,
      "shared.agency": `export static const sharedStatic = "S"\n`,
    });
    try {
      const g = buildInitDepGraph(programs, symbolTable, abs("entry.agency"));
      const keyShared = makeKey(abs("shared.agency"), "sharedStatic");
      const keyA = makeKey(abs("left.agency"), "aStatic");
      const keyB = makeKey(abs("right.agency"), "bStatic");
      expect(g.nodes[keyShared]).toBeDefined();
      expect(g.edges[keyA]).toEqual([keyShared]);
      expect(g.edges[keyB]).toEqual([keyShared]);
      // Only one shared node, even though imported from two places.
      const sharedNodes = Object.keys(g.nodes).filter(
        (k) => k.endsWith("::sharedStatic"),
      );
      expect(sharedNodes).toEqual([keyShared]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("represents a direct cycle without exploding (Task 2 detects it)", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { barStatic } from "./bar.agency"\n` +
        `export static const fooStatic = barStatic + "!"\n`,
      "bar.agency":
        `import { fooStatic } from "./foo.agency"\n` +
        `export static const barStatic = fooStatic + "?"\n`,
    });
    try {
      const g = buildInitDepGraph(programs, symbolTable, abs("foo.agency"));
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(g.edges[keyFoo]).toEqual([keyBar]);
      expect(g.edges[keyBar]).toEqual([keyFoo]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT add an edge for a referenced function name (only values)", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { getBarStatic } from "./bar.agency"\n` +
        `static const fooStatic = getBarStatic() + "!"\n` +
        `node main() { return fooStatic }\n`,
      "bar.agency":
        `export static const barStatic = "hello"\n` +
        `export def getBarStatic(): string { return barStatic }\n`,
    });
    try {
      const g = buildInitDepGraph(programs, symbolTable, abs("foo.agency"));
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      // fooStatic references getBarStatic (a def) and indirectly barStatic
      // (through it). The dep graph should NOT add an edge for either —
      // defs aren't init nodes, and call-graph analysis is out of scope.
      expect(g.edges[keyFoo]).toEqual([]);
      // But file-import edges should still capture foo → bar so the
      // topsort can use them as a tiebreaker.
      expect(g.fileImports[abs("foo.agency")]).toContain(abs("bar.agency"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
