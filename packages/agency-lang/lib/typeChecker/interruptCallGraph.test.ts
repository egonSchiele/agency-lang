import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { liftCallbackBlocks } from "../preprocessors/liftCallbacks.js";
import { typeCheck } from "./index.js";
import type {
  CallGraphFunction,
  InterruptCallGraph,
} from "./interruptAnalysis.js";

function callGraphFrom(source: string) {
  const file = path.join(
    os.tmpdir(),
    `tc-cg-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const lifted = liftCallbackBlocks(parseResult.result);
    const info = buildCompilationUnit(lifted, symbolTable, absPath, source);
    return typeCheck(lifted, {}, info).interruptCallGraph;
  } finally {
    unlinkSync(file);
  }
}

/** Look up a call graph entry by unqualified name. The call graph is
 *  keyed by `${file}:${name}` so plain `cg["main"]` no longer works;
 *  the test fixtures use a single tmp file, so a single name should
 *  match exactly one entry. */
function entry(cg: InterruptCallGraph, name: string): CallGraphFunction {
  const matches = Object.values(cg).filter((e) => e.name === name);
  if (matches.length === 0) {
    throw new Error(`No call graph entry for '${name}' (have: ${Object.values(cg).map((e) => e.name).join(", ")})`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple call graph entries for '${name}'`);
  }
  return matches[0];
}

describe("buildInterruptCallGraph", () => {
  it("records an interrupt site with enclosing handle blocks, including the right block identity", () => {
    const cg = callGraphFrom(`
node main() {
  handle {
    interrupt std::read("hi")
  } with approve
}
`);
    const main = entry(cg, "main");
    expect(main).toBeDefined();
    expect(main.file).toMatch(/\.agency$/);
    expect(main.interruptSites).toHaveLength(1);
    const site = main.interruptSites[0];
    expect(site.site.kind).toBe("std::read");
    expect(site.file).toBe(main.file); // site file matches enclosing function's file
    expect(site.enclosingHandlers).toHaveLength(1);
    // Identity check: the captured handler is the `handle {` on the third
    // line of the source. `loc.line` is 0-indexed (see parser.test.ts
    // "loc.line invariant"), so 0-indexed line 2 ≡ 1-indexed line 3.
    expect(site.enclosingHandlers[0].block.loc?.line).toBe(2);
    expect(site.enclosingHandlers[0].file).toBe(main.file);
  });

  it("records a call edge with the right enclosing handler identity", () => {
    const cg = callGraphFrom(`
def helper() {
  interrupt std::read("hi")
}

node main() {
  handle {
    helper()
  } with approve
}
`);
    const main = entry(cg, "main");
    const edge = main.callEdges.find((e) => e.calleeName === "helper");
    expect(edge).toBeDefined();
    expect(edge!.enclosingHandlers).toHaveLength(1);
    // 0-indexed line 6 ≡ 1-indexed line 7 (the `handle {` line).
    expect(edge!.enclosingHandlers[0].block.loc?.line).toBe(6);
    // Local callee → calleeKey is `${currentFile}:helper`.
    expect(edge!.calleeKey).toBe(`${main.file}:helper`);
  });

  it("records a call edge with NO enclosing handlers when the call is bare", () => {
    const cg = callGraphFrom(`
def helper() {
  interrupt std::read("hi")
}

node main() {
  helper()
}
`);
    const main = entry(cg, "main");
    const edge = main.callEdges.find((e) => e.calleeName === "helper");
    expect(edge).toBeDefined();
    expect(edge!.enclosingHandlers).toHaveLength(0);
  });

  it("attaches enclosing handlers to llm() tool-argument synthetic edges", () => {
    const cg = callGraphFrom(`
def deleteEmails() {
  interrupt std::write("delete?")
}

node main() {
  handle {
    let _: string = llm("do work", { tools: [deleteEmails] })
  } with approve
}
`);
    const main = entry(cg, "main");
    const synthetic = main.callEdges.find((e) => e.calleeName === "deleteEmails");
    expect(synthetic).toBeDefined();
    // Critical: the synthetic edge must inherit the handlers from the
    // llm(...) call site, otherwise llm-tool propagation silently loses
    // handlers downstream.
    expect(synthetic!.enclosingHandlers).toHaveLength(1);
  });

  it("records a gotoStatement target as a call edge", () => {
    const cg = callGraphFrom(`
node finish() {
  interrupt std::read("hi")
}

node main() {
  goto finish()
}
`);
    const main = entry(cg, "main");
    const edge = main.callEdges.find((e) => e.calleeName === "finish");
    expect(edge).toBeDefined();
    expect(edge!.calleeKey).toBe(`${main.file}:finish`);
  });

  it("populates CallGraphFunction.file from the file currently being typechecked", () => {
    const cg = callGraphFrom(`
def helper() {}

node main() {
  helper()
}
`);
    const main = entry(cg, "main");
    const helper = entry(cg, "helper");
    expect(main.file).toMatch(/\.agency$/);
    expect(helper.file).toBe(main.file);
  });

  it("skips the top-level scope and keys entries by `${file}:${name}`", () => {
    const cg = callGraphFrom(`
node main() {
  interrupt std::read("hi")
}
`);
    // There is no synthetic `top-level` key in the qualified-key graph.
    expect(Object.values(cg).some((e) => e.name === "top-level")).toBe(false);
    expect(Object.values(cg).map((e) => e.name)).toEqual(["main"]);
    const main = entry(cg, "main");
    expect(Object.keys(cg)).toEqual([`${main.file}:main`]);
  });

  it("records every distinct interrupt site in one function", () => {
    const cg = callGraphFrom(`
node main() {
  interrupt std::read("hi")
  interrupt std::write("bye")
}
`);
    const main = entry(cg, "main");
    expect(main.interruptSites).toHaveLength(2);
    expect(main.interruptSites.map((s) => s.site.kind)).toEqual(["std::read", "std::write"]);
  });
});
