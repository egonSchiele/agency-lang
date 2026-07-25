import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { TypescriptPreprocessor } from "../preprocessors/typescriptPreprocessor.js";
import { TypeScriptBuilder } from "../backends/typescriptBuilder.js";
import { printTs } from "../ir/prettyPrint.js";
import { generateTypeScript } from "../backends/typescriptGenerator.js";
import type { AgencyProgram } from "../types.js";
import { manyFunctions } from "./fixtures.js";
import { growthFactor, expectPerf, GROWTH_BOUND } from "./harness.js";

// Compile is measured PER STAGE on in-memory strings, not just end to end: a
// quadratic in preprocess or codegen would hide inside a single "compile" number
// (the AL0002 lesson applied to the pipeline). Strings never touch the file-based
// parse cache, so no cache neutralization is needed.
//
// Re-runnability matters because growthFactor runs each closure 9x on the same
// setup. `parse`, `bind`, and `generate` are genuinely re-runnable: parse yields
// a fresh program each call; buildCompilationUnit does not mutate the program;
// TypeScriptBuilder.build does not mutate the preprocessed program (all verified).
// But `preprocess` reassigns program.nodes in place (and so does the internal
// preprocess in `postParse`/generateTypeScript), so those two clone the program
// per call — otherwise calls 2..9 would preprocess an already-preprocessed
// program and measure a warm re-run, not cold work. The clone is ~1% of the
// stage cost here, so it does not mask a regression.
//
// LARGE is kept modest (the full pipeline at 800 functions already emits ~5MB of
// TS per call). Revisit during calibration if any stage's baseline sits well
// above 1.0 — that would mean N is too small to separate its regressions.

const SMALL = 100;
const LARGE = 800;

function parse(n: number): AgencyProgram {
  const p = parseAgency(manyFunctions(n), {}, false);
  if (!p.success) throw new Error("fixture did not parse");
  return p.result;
}

// Each stage builder runs the untimed prefix and returns a closure over just the
// stage under test.
const stages: Record<string, (n: number) => () => unknown> = {
  parse: (n) => {
    const src = manyFunctions(n);
    return () => parseAgency(src, {}, false);
  },
  bind: (n) => {
    const program = parse(n);
    return () => buildCompilationUnit(program);
  },
  preprocess: (n) => {
    const program = parse(n);
    return () => {
      const p = structuredClone(program);
      return new TypescriptPreprocessor(p, {}, buildCompilationUnit(p)).preprocess();
    };
  },
  generate: (n) => {
    const program = parse(n);
    const unit = buildCompilationUnit(program);
    const preprocessed = new TypescriptPreprocessor(program, {}, unit).preprocess();
    return () => printTs(new TypeScriptBuilder({}, unit, "m").build(preprocessed));
  },
  // Post-parse pipeline (bind → preprocess → build → print); parse is its own
  // stage above, so this deliberately excludes it.
  postParse: (n) => {
    const program = parse(n);
    return () => generateTypeScript(structuredClone(program), {}, undefined, "m");
  },
};

describe("compile per-stage scaling", () => {
  it("each stage scales linearly in file size", () => {
    // work-happened: the full pipeline produces real TypeScript for the fixture.
    const ts = generateTypeScript(parse(LARGE), {}, undefined, "m");
    expect(ts).toContain("fn0");

    for (const [name, build] of Object.entries(stages)) {
      expectPerf(`compile:${name}`, growthFactor(build, SMALL, LARGE), GROWTH_BOUND);
    }
  });
});
