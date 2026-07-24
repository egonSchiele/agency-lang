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

// Explicit-severity harness, per holes.test.ts / definiteReturns.test.ts:
// several checks are config-gated (undefinedVariables ships silent), so a
// default-config pass can be vacuously green. Sanity anchors below prove
// each check actually fires in this harness before the literal is exempted
// from it.
const STRICT: AgencyConfig = {
  typechecker: { checks: { undefinedVariables: "error" } },
} as AgencyConfig;

function diagnosticsOf(source: string): TypeCheckError[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-codelit-"));
  try {
    const file = path.join(dir, "main.agency");
    fs.writeFileSync(file, source);
    const parsed = parseAgency(source);
    if (!parsed.success) throw new Error(parsed.message);
    const symbols = SymbolTable.build(file);
    const info = buildCompilationUnit(parsed.result, symbols, file, source);
    return typeCheck(parsed.result, STRICT, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function codesOf(source: string): string[] {
  return diagnosticsOf(source).map((diag) => diag.code ?? "");
}

function messagesOf(source: string): string[] {
  return diagnosticsOf(source).map((diag) => diag.message);
}

describe("code literals: typechecking", () => {
  it("a literal assigned to a Code-annotated variable typechecks", () => {
    const source = [
      'import { fill } from "std::agency"',
      "",
      "node main(): string {",
      "  const t = [| 1 + 2 |]",
      "  return \"ok\"",
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toEqual([]);
  });

  it("fill(literal, ...) typechecks — the structural-compatibility proof", () => {
    // The synthesized type's `type`/`kind` fields are the exact
    // literal/union from stdlib Code; a wider `string` there fails this.
    const source = [
      'import { fill, toSource } from "std::agency"',
      "",
      "node main(): string {",
      "  const tpl = [|",
      "    const x: number = #n",
      "  |]",
      "  const filled = fill(tpl, { n: 1 })",
      "  if (isFailure(filled)) {",
      "    return \"fill failed\"",
      "  }",
      "  return toSource(filled.value)",
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toEqual([]);
  });

  it("names inside a body produce no host diagnostics (quoted-leaf proof)", () => {
    // Non-vacuous by construction: the SAME undefined name at host level
    // is the sanity anchor below.
    const quoted = [
      "node main(): number {",
      "  const t = [| definitelyNotAHostName() |]",
      "  return 1",
      "}",
      "",
    ].join("\n");
    expect(messagesOf(quoted).filter((m) => m.includes("definitelyNotAHostName"))).toEqual([]);
  });

  it("sanity anchor: the same undefined name AT HOST LEVEL does diagnose", () => {
    const host = [
      "node main(): number {",
      "  const t = definitelyNotAHostName()",
      "  return 1",
      "}",
      "",
    ].join("\n");
    expect(messagesOf(host).some((m) => m.includes("definitelyNotAHostName"))).toBe(true);
  });

  it("a literal in return position satisfies definite returns", () => {
    const source = [
      "def makeTemplate(): any {",
      "  return [| 1 + 2 |]",
      "}",
      "",
      "node main(): number {",
      "  return 1",
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toEqual([]);
  });
});
