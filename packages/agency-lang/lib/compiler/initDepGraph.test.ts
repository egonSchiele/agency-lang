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

  it("the function name itself is not an edge target (only values are)", () => {
    // The bare reference to the function name `getBarStatic` does not
    // become an edge to a function node — function defs aren't tracked
    // as init-var nodes. PR-2.5 depth-1 expansion DOES add an edge to
    // any top-level value the function's body reads (covered by the
    // "depth-1: cross-module static read through a named-import
    // function" test below); here we just confirm that the function
    // node itself never appears in the graph.
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
      const keyGetBar = makeKey(abs("bar.agency"), "getBarStatic");
      expect(staticGraph.nodes[keyGetBar]).toBeUndefined();
      // Depth-1 expansion still finds the static read through the call.
      expect(staticGraph.edges[keyFoo]).toEqual([keyBar]);
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

  // ── PR-2.5: depth-1 function-body expansion ──────────────────────

  it("depth-1: same-file static const consuming a local helper's static read", () => {
    // `getBase()` reads `base`. Without depth-1, `derived → getBase`
    // is a function reference, not a value edge — so the topsort
    // wouldn't know `derived` needs `base` initialized first. With
    // depth-1, walking `getBase`'s body adds the `base` edge.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const base = "hello"\n` +
        `def getBase(): string { return base }\n` +
        `static const derived = getBase() + "!"\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const k = (n: string) => makeKey(abs("entry.agency"), n);
      expect(staticGraph.edges[k("derived")]).toContain(k("base"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: cross-module static read through a named-import function", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { getBarStatic } from "./bar.agency"\n` +
        `static const fooStatic = getBarStatic() + "!"\n`,
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
      expect(staticGraph.edges[keyFoo]).toContain(keyBar);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: cross-module read through a namespace-prefixed call", () => {
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import * as bar from "./bar.agency"\n` +
        `static const fooStatic = bar.getBarStatic() + "!"\n`,
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
      expect(staticGraph.edges[keyFoo]).toContain(keyBar);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: static reading a global through a function is a compile error", () => {
    // Pre-PR-2.5 this compiled cleanly (the dep graph couldn't see
    // through `getBarGlobal`'s body). Post-PR-2.5
    // `rejectStaticReferencesGlobal` runs the same depth-1 walk and
    // catches it at compile time.
    //
    // `barGlobal` is intentionally unexported: only `static const`
    // declarations can be exported in Agency. The function that reads
    // it is exported instead, which is the realistic pattern users
    // hit and the one this rule needs to catch.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { getBarGlobal } from "./bar.agency"\n` +
        `static const fooStatic = getBarGlobal() + "!"\n`,
      "bar.agency":
        `const barGlobal = "G"\n` +
        `export def getBarGlobal(): string { return barGlobal }\n`,
    });
    try {
      expect(() =>
        buildInitDepGraphs(programs, symbolTable, abs("foo.agency")),
      ).toThrow(StaticReferencesGlobalError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: depth-2 chain NOT chased; runtime trap covers", () => {
    // `outerFn` calls `innerFn` which reads `barStatic`. Depth-1 only
    // sees the *direct* call from `foo`'s init → `outerFn`. From
    // `outerFn`'s body we collect refs and resolve in `bar.agency`,
    // but `outerFn` only references `innerFn` — not `barStatic`
    // directly. So `fooStatic` does NOT gain a direct edge to
    // `barStatic`. The runtime PR-1 trap remains the safety net.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { outerFn } from "./bar.agency"\n` +
        `static const fooStatic = outerFn() + "!"\n`,
      "bar.agency":
        `export static const barStatic = "hello"\n` +
        `def innerFn(): string { return barStatic }\n` +
        `export def outerFn(): string { return innerFn() }\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("foo.agency"),
      );
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(staticGraph.edges[keyFoo]).not.toContain(keyBar);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: function value stored in a variable does NOT expand", () => {
    // `f` is a function VALUE, not a callable name in the init
    // expression that resolves to a function def. The depth-1
    // expansion only fires when the call's identifier itself names a
    // top-level function — `f` doesn't.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const base = "hello"\n` +
        `def getBase(): string { return base }\n` +
        // `helper` captures the function value; `derived` calls
        // through the value. No expansion → no edge to `base`.
        `static const helper = getBase\n` +
        `static const derived = helper() + "!"\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const k = (n: string) => makeKey(abs("entry.agency"), n);
      expect(staticGraph.edges[k("derived")]).not.toContain(k("base"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: stdlib / unknown names skip silently with no edges", () => {
    // No `uppercase` def anywhere in the closure — `FunctionDefLookup`
    // returns null and the depth-1 path is a no-op.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const foo = "hi"\n` +
        `static const result = uppercase(foo)\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const k = (n: string) => makeKey(abs("entry.agency"), n);
      // The direct ref to `foo` is still recorded; depth-1 just adds
      // no extra edges since `uppercase` doesn't resolve to a def.
      expect(staticGraph.edges[k("result")]).toEqual([k("foo")]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: self-recursive function does not loop and yields the right edge", () => {
    // `countDown` calls itself. The depth-1 expansion walks the body
    // ONCE — recursion is not chased. The inner ref `countDown` is a
    // function name, not in `lookupSet`, so no edge is added for it.
    // The ref `base` inside the body DOES resolve to a top-level
    // static and contributes the edge.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const base = "hello"\n` +
        `def countDown(n: number): string {\n` +
        `  if (n <= 0) { return base }\n` +
        `  return countDown(n - 1)\n` +
        `}\n` +
        `static const derived = countDown(3) + "!"\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const k = (n: string) => makeKey(abs("entry.agency"), n);
      expect(staticGraph.edges[k("derived")]).toContain(k("base"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: walks block bodies inside the called function", () => {
    // `map(arr) as x { ... }` is an inline block (NOT a nested
    // function), so refs inside the block body still count toward the
    // depth-1 expansion when we walk `mapWithBase`'s body. The block
    // parameter `x` shadows nothing — it doesn't resolve to a top-
    // level decl, so it falls out harmlessly.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const base = "hello"\n` +
        `static const items = ["a", "b"]\n` +
        `def mapWithBase(): string[] {\n` +
        `  return map(items) as x {\n` +
        `    return x + base\n` +
        `  }\n` +
        `}\n` +
        `static const derived = mapWithBase()\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const k = (n: string) => makeKey(abs("entry.agency"), n);
      expect(staticGraph.edges[k("derived")]).toContain(k("base"));
      expect(staticGraph.edges[k("derived")]).toContain(k("items"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: re-exported function expansion still finds the source-module dep", () => {
    // The function `getBar` is re-exported once. Pre-fix, the depth-1
    // lookup stopped at the re-exporter's synthesized wrapper
    // (`return _reexport_getBar(...)`), whose body the free-ref walker
    // can't see through — so no edge was added and the runtime trap
    // would be the only safety net even though it's a single direct
    // call in user source. The fix follows the SymbolTable's
    // `reExportedFrom` chain to the ultimate `def` and walks that
    // real body, contributing the cross-module edge to the source
    // module's static.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "foo.agency":
        `import { getBar } from "./mid.agency"\n` +
        `static const fooStatic = getBar() + "!"\n` +
        `node main() { return fooStatic }\n`,
      "mid.agency": `export { getBar } from "./bar.agency"\n`,
      "bar.agency":
        `export static const barStatic = "hello"\n` +
        `export def getBar(): string { return barStatic }\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("foo.agency"),
      );
      const keyFoo = makeKey(abs("foo.agency"), "fooStatic");
      const keyBar = makeKey(abs("bar.agency"), "barStatic");
      expect(staticGraph.edges[keyFoo]).toContain(keyBar);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: parameter that shadows a top-level decl does NOT create a spurious edge", () => {
    // `readArg`'s body reads its own parameter `barStatic`, NOT the
    // top-level static of the same name. Without parameter-shadow
    // filtering in `collectFunctionBodyFreeRefs`, the inner ref would
    // resolve to the top-level binding and add a phantom edge from
    // `derived` to `barStatic` — which happens to be benign here
    // (barStatic IS a static), but the same bug surfaces as a false
    // `StaticReferencesGlobalError` if the shadowed name is a global.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `static const barStatic = "real"\n` +
        `def readArg(barStatic: string): string { return barStatic }\n` +
        `static const derived = readArg("arg") + "!"\n`,
    });
    try {
      const { staticGraph } = buildInitDepGraphs(
        programs,
        symbolTable,
        abs("entry.agency"),
      );
      const k = (n: string) => makeKey(abs("entry.agency"), n);
      expect(staticGraph.edges[k("derived")]).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("depth-1: parameter shadowing a global does NOT cause a false static-references-global error", () => {
    // The dangerous case: a function parameter shadows a top-level
    // GLOBAL. Without filtering, walking the function body would
    // resolve `g` to the top-level global and `rejectStaticReferencesGlobal`
    // would throw, even though the body only reads the parameter.
    const { dir, programs, symbolTable, abs } = writeFixture({
      "entry.agency":
        `const g = "global"\n` +
        `def readG(g: string): string { return g }\n` +
        `static const s = readG("arg") + "!"\n`,
    });
    try {
      expect(() =>
        buildInitDepGraphs(programs, symbolTable, abs("entry.agency")),
      ).not.toThrow();
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
