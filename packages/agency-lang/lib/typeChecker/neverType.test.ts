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

describe("never type — member access", () => {
  it("property access on a never-typed value does not error", () => {
    expect(check(`def f(x: never): never { return x.foo }`)).toEqual([]);
  });

  it("index access on a never-typed value does not error", () => {
    expect(check(`def g(x: never): never { return x[0] }`)).toEqual([]);
  });
});
