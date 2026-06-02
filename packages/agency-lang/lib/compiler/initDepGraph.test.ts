import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type { AgencyProgram } from "../types.js";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import {
  buildInitDepGraphs,
  makeKey,
  StaticReferencesGlobalError,
} from "./initDepGraph.js";
import { resolveReExports } from "../preprocessors/resolveReExports.js";

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
  const raw: Record<string, AgencyProgram> = {};
  for (const [relPath, source] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, source, "utf-8");
    raw[absPath] = parse(source);
  }
  const entry = path.join(dir, Object.keys(files)[0]);
  const symbolTable = SymbolTable.build(entry, {});
  // Mirror what `compileClosure.parseClosure` does: expand each
  // program through `resolveReExports` so the dep graph sees the
  // synthesized wrapper statics at re-exporters. Without this the
  // unit tests would diverge from production behavior.
  const programs: Record<string, AgencyProgram> = {};
  for (const [absPath, program] of Object.entries(raw)) {
    programs[absPath] = resolveReExports(program, symbolTable, absPath);
  }
  return {
    dir,
    programs,
    symbolTable,
    abs: (rel) => path.join(dir, rel),
  };
}

describe("buildInitDepGraphs", () => {
  it("returns empty graphs for a module with no top-level decls", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency": `node main() { return 1 }\n`,
    });
    try {
      const { staticGraph, globalGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      expect(Object.keys(staticGraph.nodes)).toEqual([]);
      expect(Object.keys(globalGraph.nodes)).toEqual([]);
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
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const keyA = makeKey(abs("entry.agency"), "a");
      const keyB = makeKey(abs("entry.agency"), "b");
      expect(staticGraph.nodes[keyA]).toBeDefined();
      expect(staticGraph.nodes[keyB]).toBeDefined();
      expect(staticGraph.nodes[keyA]?.kind).toBe("static");
      expect(staticGraph.edges[keyB]).toEqual([keyA]);
      expect(staticGraph.edges[keyA]).toEqual([]);
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
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("foo.agency"),
      );
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(staticGraph.nodes[keyFoo]).toBeDefined();
      expect(staticGraph.nodes[keyBar]).toBeDefined();
      expect(staticGraph.edges[keyFoo]).toEqual([keyBar]);
      expect(staticGraph.edges[keyBar]).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cascades re-exported statics one hop at a time", () => {
    // `resolveReExports` synthesizes a wrapper `static const barStatic`
    // in reexport.agency. The dep graph resolves imports one hop at a
    // time, so:
    //   foo.fooStatic → reexport.barStatic (wrapper) → bar.barStatic
    // Each link is its own edge in the static graph, which makes the
    // runtime cascade walk every wrapper's `__initializeStatic` in turn.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { barStatic } from "./reexport.agency"\n` +
        `static const fooStatic = barStatic + "!"\n` +
        `node main() { return fooStatic }\n`,
      "reexport.agency": `export { barStatic } from "./bar.agency"\n`,
      "bar.agency": `export static const barStatic = "hello"\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("foo.agency"),
      );
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyReexport = makeKey(abs("reexport.agency"), "barStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(staticGraph.nodes[keyReexport]).toBeDefined();
      expect(staticGraph.edges[keyFoo]).toEqual([keyReexport]);
      expect(staticGraph.edges[keyReexport]).toEqual([keyBar]);
      expect(staticGraph.edges[keyBar]).toEqual([]);
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
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const keyShared = makeKey(abs("shared.agency"), "sharedStatic");
      const keyA = makeKey(abs("left.agency"), "aStatic");
      const keyB = makeKey(abs("right.agency"), "bStatic");
      expect(staticGraph.nodes[keyShared]).toBeDefined();
      expect(staticGraph.edges[keyA]).toEqual([keyShared]);
      expect(staticGraph.edges[keyB]).toEqual([keyShared]);
      const sharedNodes = Object.keys(staticGraph.nodes).filter((k) =>
        k.endsWith("::sharedStatic"),
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
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("foo.agency"),
      );
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(staticGraph.edges[keyFoo]).toEqual([keyBar]);
      expect(staticGraph.edges[keyBar]).toEqual([keyFoo]);
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
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("foo.agency"),
      );
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(staticGraph.edges[keyFoo]).toEqual([]);
      // sequenceHint reflects the file-import-depth tiebreaker so
      // example-2 still initializes bar before foo.
      expect(staticGraph.nodes[keyBar]!.sequenceHint).toBeLessThan(
        staticGraph.nodes[keyFoo]!.sequenceHint,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── New phase-coupling and node-classification tests ──

  it("puts statics and globals into separate graphs", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const s = "static"\n` +
        `const g = "global"\n` +
        `node main() { return s }\n`,
    });
    try {
      const { staticGraph, globalGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const sKey = makeKey(abs("entry.agency"), "s");
      const gKey = makeKey(abs("entry.agency"), "g");
      expect(staticGraph.nodes[sKey]?.kind).toBe("static");
      expect(staticGraph.nodes[gKey]).toBeUndefined();
      expect(globalGraph.nodes[gKey]?.kind).toBe("global");
      expect(globalGraph.nodes[sKey]).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a static and global with the same name across phases", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const x = "S"\n` +
        // Different module so the static and global "x" share a name
        // without clobbering each other in their own graphs.
        ``,
      // separate file to host a same-named global
      "other.agency": `const x = "G"\n`,
    });
    try {
      const { staticGraph, globalGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      expect(staticGraph.nodes[makeKey(abs("entry.agency"), "x")]).toBeDefined();
      expect(globalGraph.nodes[makeKey(abs("other.agency"), "x")]).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a static initializer that references a global", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `const g = "hello"\n` +
        `static const s = g + "!"\n` +
        `node main() { return s }\n`,
    });
    try {
      expect(() =>
        buildInitDepGraphs(programs, symbolTable, abs("entry.agency")),
      ).toThrow(StaticReferencesGlobalError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a global initializer to reference a static (cross-phase OK)", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const s = "hello"\n` +
        `const g = s + "!"\n` +
        `node main() { return g }\n`,
    });
    try {
      const { staticGraph, globalGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const sKey = makeKey(abs("entry.agency"), "s");
      const gKey = makeKey(abs("entry.agency"), "g");
      expect(staticGraph.nodes[sKey]).toBeDefined();
      expect(globalGraph.nodes[gKey]).toBeDefined();
      // Cross-phase reference produces NO edge in either graph.
      expect(globalGraph.edges[gKey]).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("represents bare top-level function calls as global-graph nodes", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `def hello(): string { return "hi" }\n` +
        `hello()\n` +
        `const g = "after"\n` +
        `hello()\n` +
        `node main() { return g }\n`,
    });
    try {
      const { staticGraph, globalGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const bareNodes = Object.values(globalGraph.nodes).filter((n) =>
        n.varName.startsWith("__bareStmt_"),
      );
      expect(bareNodes.length).toBe(2);
      // No statics get bare statements (PR 3 work).
      expect(
        Object.values(staticGraph.nodes).some((n) =>
          n.varName.startsWith("__bareStmt_"),
        ),
      ).toBe(false);
      // Source order: first bare call < global g < second bare call by
      // sequenceHint (within the same module: hint = depth*1e6 + line).
      const sorted = [...bareNodes].sort(
        (a, b) => a.sequenceHint - b.sequenceHint,
      );
      const gNode = globalGraph.nodes[makeKey(abs("entry.agency"), "g")]!;
      expect(sorted[0]!.sequenceHint).toBeLessThan(gNode.sequenceHint);
      expect(sorted[1]!.sequenceHint).toBeGreaterThan(gNode.sequenceHint);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not crash when an initializer references a name outside the closure", () => {
    // `unknownName` doesn't bind anywhere in the closure. Dep graph
    // should produce no edge and not throw — the typechecker reports
    // the undefined-name error separately.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const s = unknownName + "!"\n` +
        `node main() { return s }\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const sKey = makeKey(abs("entry.agency"), "s");
      expect(staticGraph.nodes[sKey]).toBeDefined();
      expect(staticGraph.edges[sKey]).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds a cross-module edge for a namespace-imported static (bar.x)", () => {
    // Regression: `import * as bar from "./bar.agency"` was invisible
    // to the init dep graph — `bar.barStatic` did not produce an
    // edge, so foo's static initializer could run before bar's
    // __initializeStatic. The fix resolves `(bar, "barStatic")` via
    // the namespace alias resolver and registers the same cross-
    // module edge a named import would have produced.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import * as bar from "./bar.agency"\n` +
        `static const fooStatic = bar.barStatic + "!"\n` +
        `node main() { return fooStatic }\n`,
      "bar.agency": `export static const barStatic = "hello"\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("foo.agency"),
      );
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(staticGraph.edges[keyFoo]).toEqual([keyBar]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a namespace-imported global referenced from a static initializer", () => {
    // Same cross-phase rule as for named imports: a `static const`
    // initializer cannot read a `global` const, even through a
    // namespace alias. Without surfacing namespace refs, this would
    // silently compile and trip the runtime read-before-init trap at
    // first call instead of failing at compile time.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import * as bar from "./bar.agency"\n` +
        `static const fooStatic = bar.barGlobal + "!"\n`,
      "bar.agency": `export const barGlobal = "G"\n`,
    });
    try {
      expect(() =>
        buildInitDepGraphs(programs, symbolTable, abs("foo.agency")),
      ).toThrow(StaticReferencesGlobalError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collects free-var refs from string interpolation, spreads, new, splats", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const a = "A"\n` +
        `static const b = "B"\n` +
        `static const c = "C"\n` +
        `static const d = "D"\n` +
        `static const e = "E"\n` +
        // String interpolation reference.
        `static const interp = "x${"${a}"}"\n` +
        // Array spread.
        `static const arrSpread = [...[b]]\n` +
        // Object spread.
        `static const objSpread = {...{ k: c }}\n` +
        // Splat call arg into a stdlib-like fn — the function name
        // itself doesn't create a value edge, but the splat target does.
        `def take(...xs: string[]): string { return "" }\n` +
        `static const splat = take(...[d])\n` +
        // Plain reference for baseline.
        `static const plain = e + "!"\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const k = (n: string) => makeKey(abs("entry.agency"), n);
      expect(staticGraph.edges[k("interp")]).toEqual([k("a")]);
      expect(staticGraph.edges[k("arrSpread")]).toEqual([k("b")]);
      expect(staticGraph.edges[k("objSpread")]).toEqual([k("c")]);
      expect(staticGraph.edges[k("splat")]).toEqual([k("d")]);
      expect(staticGraph.edges[k("plain")]).toEqual([k("e")]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
