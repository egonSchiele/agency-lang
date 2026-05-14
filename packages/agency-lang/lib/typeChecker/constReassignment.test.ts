import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

describe("const reassignment detection", () => {
  it("errors on bare reassignment to a const", () => {
    const errs = check(`
node main() {
  const x = 1
  x = 2
}
`);
    expect(errs).toContain("Cannot reassign to constant 'x'.");
  });

  it("errors on compound assignment to a const (+=)", () => {
    const errs = check(`
node main() {
  const x = 1
  x += 1
}
`);
    expect(errs).toContain("Cannot reassign to constant 'x'.");
  });

  it("errors on every compound-assign operator targeting a const", () => {
    for (const op of ["+=", "-=", "*=", "/=", "&&=", "||=", "??="]) {
      const errs = check(`
node main() {
  const x = 1
  x ${op} 1
}
`);
      expect(errs, `operator ${op}`).toContain("Cannot reassign to constant 'x'.");
    }
  });

  it("errors on postfix ++ and -- targeting a const", () => {
    for (const op of ["++", "--"]) {
      const errs = check(`
node main() {
  const x = 1
  x${op}
}
`);
      expect(errs, `operator ${op}`).toContain("Cannot reassign to constant 'x'.");
    }
  });

  it("does not error on let bindings using the same operators", () => {
    const errs = check(`
node main() {
  let x = 1
  x = 2
  x += 1
  x++
}
`);
    expect(errs.filter((m) => m.includes("Cannot reassign"))).toEqual([]);
  });

  it("does not error on property writes through a const object", () => {
    // const objects can have their fields mutated, matching JS semantics.
    const errs = check(`
node main() {
  const o = { count: 0 }
  o.count = 1
}
`);
    expect(errs.filter((m) => m.includes("Cannot reassign"))).toEqual([]);
  });
});
