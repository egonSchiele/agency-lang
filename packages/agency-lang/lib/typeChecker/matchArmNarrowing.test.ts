import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function hardErrors(source: string): string[] {
  const file = path.join(os.tmpdir(), `tc-marm-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`);
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, source);
    return typeCheck(parseResult.result, {}, info).errors
      .filter((e) => (e.severity ?? "error") === "error")
      .map((e) => e.message);
  } finally {
    unlinkSync(file);
  }
}

const HEAD = `
effect app::confirm { question: string }
effect app::rateLimited { retryAfter: number }
def ask(q: string): string { return q }
def waitFor(n: number): number { return n }
def risky() { raise app::confirm("c", { question: "ok?" })\n raise app::rateLimited("r", { retryAfter: 5 }) }`;

describe("match-arm receiver narrowing (H4)", () => {
  it("match(e.effect) narrows e.data per arm — clean when types match", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm"     => ask(e.data.question)
      "app::rateLimited" => waitFor(e.data.retryAfter)
    }
  }
}`);
    expect(errs).toEqual([]);
  });

  it("match(e.effect) still flags a genuine payload-type mismatch in an arm", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm"     => waitFor(e.data.question)
      "app::rateLimited" => waitFor(e.data.retryAfter)
    }
  }
}`);
    // e.data.question is string, waitFor wants number → error in the confirm arm.
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });
});
