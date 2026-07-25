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
// (the lesson of the AL0002 bug, applied to the pipeline). Strings never touch
// the file-based parse cache, so no cache neutralization is needed here.
//
// Every stage was verified re-runnable: buildCompilationUnit does not mutate the
// program, and preprocess/build produce identical output on a repeated call.

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
    const unit = buildCompilationUnit(program);
    return () => new TypescriptPreprocessor(program, {}, unit).preprocess();
  },
  generate: (n) => {
    const program = parse(n);
    const unit = buildCompilationUnit(program);
    const preprocessed = new TypescriptPreprocessor(program, {}, unit).preprocess();
    return () => printTs(new TypeScriptBuilder({}, unit, "m").build(preprocessed));
  },
  full: (n) => {
    const program = parse(n);
    return () => generateTypeScript(program, {}, undefined, "m");
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
