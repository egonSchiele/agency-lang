import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { printTs } from "../ir/prettyPrint.js";
import type { AgencyConfig } from "@/config.js";

function generate(source: string): string {
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success)
    throw new Error(`Failed to parse: ${parseResult.message}`);
  const info = buildCompilationUnit(parseResult.result);
  const preprocessor = new TypescriptPreprocessor(parseResult.result, {}, info);
  const pre = preprocessor.preprocess();
  const builder = new TypeScriptBuilder({} as AgencyConfig, info, "test.agency");
  return printTs(builder.build(pre));
}

// Issue #470 bug 1: alias schema consts referencing not-yet-emitted aliases
// (self-recursion, forward refs, cycle back-edges) must defer with z.lazy;
// backward references stay bare (zero churn for existing code).
describe("recursive/forward alias codegen", () => {
  it("wraps a self-reference in z.lazy", () => {
    const out = generate(`
type Tree = {
  value: number,
  children: Tree[],
}
node main() {
  return 1
}
`);
    expect(out).toContain("z.array(z.lazy(() => Tree))");
  });

  it("wraps a forward reference in z.lazy but keeps backward refs bare", () => {
    const out = generate(`
type Ahead = {
  b: Behind,
}
type Behind = {
  x: number,
}
type After = {
  b: Behind,
}
node main() {
  return 1
}
`);
    expect(out).toContain("z.lazy(() => Behind)"); // forward (in Ahead)
    // Backward ref (in After) stays a bare const reference.
    expect(out).toMatch(/const After = z\.object\(\{ "b": Behind \}\)/);
  });

  it("splits a mutual cycle: forward edge lazy, backward edge bare", () => {
    const out = generate(`
type Employee = {
  name: string,
  manager: Manager | null,
}
type Manager = {
  reports: Employee[],
}
node main() {
  return 1
}
`);
    expect(out).toContain("z.lazy(() => Manager)");
    expect(out).toMatch(/const Manager = z\.object\(\{ "reports": z\.array\(Employee\) \}\)/);
  });

  it("wraps a def-before-type tool-schema reference in z.lazy", () => {
    // Tool definitions initialize at module load; a def declared before
    // the alias it references used to TDZ-crash (probe-confirmed).
    const out = generate(`
def f(x: Later): number {
  return 1
}
type Later = {
  v: number,
}
node main() {
  return f({ v: 1 })
}
`);
    expect(out).toContain("z.lazy(() => Later)");
  });

  it("rejects type Loop = Loop with a clear error", () => {
    expect(() =>
      generate(`
type Loop = Loop
node main() {
  return 1
}
`),
    ).toThrow(/circularly references itself with no structure/);
  });
});
