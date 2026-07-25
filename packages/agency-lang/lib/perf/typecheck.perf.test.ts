import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "../typeChecker/index.js";
import { manyFunctions } from "./fixtures.js";
import { growthFactor, expectPerf, GROWTH_BOUND } from "./harness.js";

// manyFunctions (n independent functions) is a LINEAR typecheck baseline, so
// this guards against a regression that makes typecheck super-linear. Note: the
// wideUnion fixture is deliberately NOT used here — the checker is already
// ~O(n^2) in union width (see the PR description), which makes it a poor
// regression fixture (a test already reading ~8 can't detect getting worse).
describe("typecheck scaling", () => {
  it("scales linearly in file size", () => {
    const parsed = parseAgency(manyFunctions(4000), {}, false);
    if (!parsed.success) throw new Error("fixture did not parse");
    const program = parsed.result;
    expect(typeCheck(program, {}, buildCompilationUnit(program)).scopes.length).toBeGreaterThan(0);

    const build = (n: number) => {
      const p = parseAgency(manyFunctions(n), {}, false);
      if (!p.success) throw new Error("fixture did not parse");
      const prog = p.result;
      // typeCheck mutates program.nodes (desugarGuardsInBody), so each timed
      // call gets a fresh clone to measure cold work, not a warm re-run. (For
      // this fixture the desugar is a no-op, but the clone stops that from
      // being a silent correctness dependency on the fixture.)
      return () => {
        const c = structuredClone(prog);
        return typeCheck(c, {}, buildCompilationUnit(c));
      };
    };
    expectPerf("typecheck:manyFunctions", growthFactor(build, 500, 4000), GROWTH_BOUND);
  });
});
