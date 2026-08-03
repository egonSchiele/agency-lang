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
import { codeLiteralTypeForTests } from "./synthesizer.js";

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

  it("names inside a body are not checked against the HOST scope (quoted-leaf proof)", () => {
    // The leaf property still holds: the host checker does not resolve a
    // quoted name against host declarations. What changed is that the
    // template pass now resolves it against the TEMPLATE's own scope, so
    // an undefined name there is AG8015 rather than silence.
    //
    // Non-vacuous by construction: the SAME undefined name at host level
    // is the sanity anchor below, and it reports a different code.
    const quoted = [
      "node main(): number {",
      "  const t = [| definitelyNotAHostName() |]",
      "  return 1",
      "}",
      "",
    ].join("\n");
    expect(codesOf(quoted)).not.toContain("AG4004");
    expect(codesOf(quoted)).toContain("AG8015");
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

// Review round: widening survives WRAPPED literals (the syntactic
// declare-site guard could not cover these; the fix moved into widenType
// as isCodeShape), and the synthesized type cannot drift from stdlib.
describe("code literals: wrapped-literal widening (review round)", () => {
  it("a literal from an array element still fills a Code parameter", () => {
    const source = [
      'import { toSource } from "std::agency"',
      "",
      "node main(): string {",
      "  const templates = [[| 1 + 2 |], [| 3 + 4 |]]",
      "  const first = templates[0]",
      "  if (first == null) {",
      '    return "none"',
      "  }",
      "  return toSource(first)",
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toEqual([]);
  });

  it("a literal reassigned across branches still fills a Code parameter", () => {
    const source = [
      'import { toSource } from "std::agency"',
      "",
      "node main(): string {",
      "  let tpl = [| 1 |]",
      "  if (true) {",
      "    tpl = [| 2 |]",
      "  }",
      "  return toSource(tpl)",
      "}",
      "",
    ].join("\n");
    expect(codesOf(source)).toEqual([]);
  });
});

describe("code literals: the synthesized type tracks stdlib Code", () => {
  it("is structurally equal to the real stdlib alias (drift guard)", () => {
    // The synthesized type is a hand-kept copy of stdlib Code's shape.
    // The fill() compatibility test catches a NEW REQUIRED field; this
    // catches renames and retyped optionals too, by comparing against
    // the alias as actually declared in stdlib/agency.agency.
    const stdlibSource = fs.readFileSync(
      path.join(__dirname, "../../stdlib/agency.agency"),
      "utf8",
    );
    const parsed = parseAgency(stdlibSource, {}, false, false);
    if (!parsed.success) throw new Error(parsed.message);
    const codeAlias = parsed.result.nodes.find(
      (node) => node.type === "typeAlias" && node.aliasName === "Code",
    ) as { aliasedType?: unknown };
    expect(codeAlias).toBeDefined();
    const strip = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value, (key, val) =>
          key === "loc" || key === "tags" ? undefined : val,
        ),
      );
    expect(strip(codeLiteralTypeForTests())).toEqual(strip(codeAlias.aliasedType));
  });
});
