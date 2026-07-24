import { describe, it, expect } from "vitest";
import { compileSource } from "../compiler/compile.js";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const oneHole = `node main(): string {\n  const p: string = #text\n  return p\n}\n`;
const twoHoles = `node main(): string {\n  const a: string = #x\n  const b: string = #y\n  return a + b\n}\n`;

function errorsOf(source: string): string {
  const result = compileSource(source, {});
  expect(result.success).toBe(false);
  if (result.success) throw new Error("unreachable");
  return result.errors.join("\n");
}

describe("a program with holes refuses to compile", () => {
  it("fails with AG8001", () => {
    expect(errorsOf(oneHole)).toContain("AG8001");
  });

  it("names the unfilled hole", () => {
    expect(errorsOf(oneHole)).toContain("#text");
  });

  it("names every unfilled hole, not just the first", () => {
    const errors = errorsOf(twoHoles);
    expect(errors).toContain("#x");
    expect(errors).toContain("#y");
  });
});

describe("pipeline stages tolerate holes", () => {
  // The stages before codegen must not crash on a hole: the LSP and the
  // template loader run them over template files. Only codegen refuses.
  function templateOnDisk(source: string): string {
    const dir = mkdtempSync(join(tmpdir(), "hole-tolerance-"));
    const file = join(dir, "template.agency");
    writeFileSync(file, source, "utf-8");
    return file;
  }

  const template = `import { read } from "std::fs"\n\nnode main(): string {\n  #setup\n  const p: string = #text\n  return p\n}\n`;

  it("the parser accepts a template", () => {
    const result = parseAgency(template, {}, false, false);
    expect(result.success).toBe(true);
  });

  it("SymbolTable.build does not throw on a hole", () => {
    const file = templateOnDisk(template);
    expect(() => SymbolTable.build(file, {})).not.toThrow();
  });

  it("buildCompilationUnit does not throw on a hole", () => {
    const file = templateOnDisk(template);
    const parsed = parseAgency(template, {}, true);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const symbolTable = SymbolTable.build(file, {});
    expect(() =>
      buildCompilationUnit(parsed.result, symbolTable, file, template),
    ).not.toThrow();
  });
});
