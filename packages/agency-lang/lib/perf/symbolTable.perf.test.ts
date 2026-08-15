import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { manyFunctions } from "./fixtures.js";
import { growthFactor, expectPerf, GROWTH_BOUND } from "./harness.js";
import { makeAgencyTempDir } from "../utils/agencyTempDir.js";
import { safeDeleteDirectory } from "../utils.js";

// SymbolTable.build gained an effect-propagation pass that walks every
// reachable file's tree and runs a fixpoint over the call graph (issue 680).
// A fixpoint is where an accidental quadratic hides, and this runs on every
// editor keystroke that rebuilds the table, so it is measured by how it scales
// rather than by a wall-clock threshold — the pass costs roughly 2ms on a small
// program, which is far too small to assert on without flaking.
//
// The fixture chains each function to the next, so the call graph is a path of
// length N. That is the shape that makes a naive fixpoint quadratic: an effect
// at the far end has to travel every edge.

const SMALL = 100;
const LARGE = 800;

let dir: string;
beforeAll(() => {
  dir = makeAgencyTempDir("symboltable-perf");
});
afterAll(() => {
  safeDeleteDirectory(dir, false);
});

/** N functions where fn0 calls fn1 calls fn2 ... and the last one reads a
 *  file, so one effect must propagate the whole length of the chain. */
function chainedFunctions(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    parts.push(`export def fn${i}(): string {`);
    parts.push(`  return fn${i + 1}()`);
    parts.push(`}`);
  }
  parts.push(`export def fn${n - 1}(): string {`);
  parts.push(`  return read("data.txt")`);
  parts.push(`}`);
  return parts.join("\n");
}

function buildFor(source: string, label: string): () => unknown {
  const file = path.join(dir, `${label}.agency`);
  fs.writeFileSync(file, source, "utf-8");
  return () => SymbolTable.build(file, {});
}

describe("SymbolTable.build scaling", () => {
  it("scales linearly in file size", () => {
    // work-happened: the effect really does travel the whole chain.
    const file = path.join(dir, "proof.agency");
    fs.writeFileSync(file, chainedFunctions(SMALL), "utf-8");
    const table = SymbolTable.build(file, {});
    const first = table.getFile(path.resolve(file))?.["fn0"];
    const effects =
      first && (first.kind === "function" || first.kind === "node")
        ? (first.interruptEffects ?? []).map((entry) => entry.effect)
        : [];
    expect(effects).toContain("std::read");

    expectPerf(
      "symbolTable:build",
      growthFactor((n) => buildFor(manyFunctions(n), `flat-${n}`), SMALL, LARGE),
      GROWTH_BOUND,
    );
  });

  it("scales linearly when one effect travels a long call chain", () => {
    expectPerf(
      "symbolTable:build-chained",
      growthFactor((n) => buildFor(chainedFunctions(n), `chain-${n}`), SMALL, LARGE),
      GROWTH_BOUND,
    );
  });
});
