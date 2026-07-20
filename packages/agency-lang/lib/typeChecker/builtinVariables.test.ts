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

describe("__dirname builtin variable", () => {
  it("types __dirname as string", () => {
    const errs = check(`
node main() {
  const x: number = __dirname
  return x
}
`);
    expect(errs.some((m) => /string/.test(m))).toBe(true);
  });

  it("allows __dirname where a string is expected", () => {
    const errs = check(`
node main() {
  const x: string = __dirname
  return x
}
`);
    expect(errs).toEqual([]);
  });

  it("lets a local binding shadow the builtin", () => {
    const errs = check(`
node main() {
  const __dirname: number = 5
  const y: number = __dirname
  return y
}
`);
    expect(errs).toEqual([]);
  });
});
