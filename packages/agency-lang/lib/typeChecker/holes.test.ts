import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { AgencyConfig } from "../config.js";
import type { TypeCheckError } from "./types.js";
import { typeCheckSource } from "../compiler/typecheck.js";
import { _loadTemplateFromString, _holesOf } from "../stdlib/template.js";

// Same harness as definiteReturns.test.ts: parse + symbol table + full
// typeCheck with an explicit config, since several checks here are
// config-gated (undefinedVariables ships silent, definiteReturns warn).
function check(src: string, config: AgencyConfig = {}): TypeCheckError[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-holes-"));
  try {
    const file = path.join(dir, "main.agency");
    fs.writeFileSync(file, src);
    const parsed = parseAgency(src);
    if (!parsed.success) throw new Error("parse failed");
    const symbols = SymbolTable.build(file);
    const info = buildCompilationUnit(parsed.result, symbols, file, src);
    return typeCheck(parsed.result, config, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function codesOf(source: string): string[] {
  const report = typeCheckSource(source);
  return [...report.errors, ...report.warnings].map((diag) => diag.code ?? "");
}

describe("AG8002: holes with no discoverable type", () => {
  it("fires when a hole has no expected type and no annotation", () => {
    expect(codesOf(`node main() {\n  const x = #mystery\n  return x\n}\n`)).toContain(
      "AG8002",
    );
  });

  it("does not fire when the position supplies a type", () => {
    expect(codesOf(`node main() {\n  const x: string = #m\n  return x\n}\n`)).not.toContain(
      "AG8002",
    );
  });

  it("does not fire when the hole is annotated", () => {
    expect(codesOf(`node main() {\n  const x = #m: string\n  return x\n}\n`)).not.toContain(
      "AG8002",
    );
  });
});

describe("names a filler could introduce do not resolve in the template", () => {
  // Decision 3: "bindings are local to the hole" is a checking rule. The
  // checker cannot see into a hole, so template code after one that uses a
  // filler-introduced name fails ordinary name resolution.
  const config: AgencyConfig = { typechecker: { undefinedVariables: "error" } };

  it("flags a name only a filler could introduce", () => {
    const source = `node main() {\n  #setup\n  print(inner)\n  return 1\n}\n`;
    const errors = check(source, config);
    expect(errors.some((diag) => diag.message.includes("inner"))).toBe(true);
  });
});

describe("definite returns and statement holes", () => {
  const DR = /^Not all code paths return a value in '/;
  const misses = (src: string) =>
    check(src).filter((e) => DR.test(e.message)).length > 0;

  it("exempts a function whose only return could come from a hole", () => {
    // Sanity anchor first: without the hole, the same shape DOES flag.
    expect(misses(`def f(): number {\n  let x = 1\n}\n`)).toBe(true);
    expect(misses(`def f(): number {\n  #body\n}\n`)).toBe(false);
  });

  it("still flags a missing return when the hole is an expr hole", () => {
    expect(misses(`def f(): number {\n  const x: number = #v\n}\n`)).toBe(true);
  });
});

describe("holesOf reports position-inferred types", () => {
  it("reads the type from an annotated assignment", () => {
    const code = _loadTemplateFromString(
      `node main() {\n  const prompt: string = #text\n  return prompt\n}\n`,
    );
    expect(_holesOf(code)).toEqual([
      { name: "text", sort: "expr", splice: false, type: "string" },
    ]);
  });
});
