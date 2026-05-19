import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

/**
 * Smoke test: a generic type alias exported from one Agency file and used
 * with type arguments in another must resolve correctly. This validates
 * that the type alias registry carries `typeParams` across module
 * boundaries (the widening in compilationUnit.ts / symbolTable.ts).
 */
function setupTwoFiles(
  aSource: string,
  bSource: string,
): { dir: string; bPath: string } {
  const dir = path.join(
    os.tmpdir(),
    `tc-cross-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "a.agency"), aSource);
  writeFileSync(path.join(dir, "b.agency"), bSource);
  return { dir, bPath: path.join(dir, "b.agency") };
}

function errorsFromFile(filePath: string, source: string): TypeCheckError[] {
  const absPath = path.resolve(filePath);
  const symbolTable = SymbolTable.build(absPath, {});
  const parseResult = parseAgency(source, {});
  if (!parseResult.success)
    throw new Error("Parse failed: " + parseResult.message);
  const program = parseResult.result;
  const info = buildCompilationUnit(program, symbolTable, absPath, source);
  return typeCheck(program, {}, info).errors;
}

describe("cross-module generic type alias", () => {
  it("resolves an exported Container<T> when used with a type argument in another file", () => {
    const { dir, bPath } = setupTwoFiles(
      `export type Container<T> = { value: T }\n`,
      `import { Container } from "./a.agency"\n` +
        `\nnode main() {\n  let c: Container<string> = { value: "hello" }\n  print(c.value)\n}\n`,
    );
    try {
      const errors = errorsFromFile(
        bPath,
        `import { Container } from "./a.agency"\n` +
          `\nnode main() {\n  let c: Container<string> = { value: "hello" }\n  print(c.value)\n}\n`,
      );
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects assigning the wrong shape to an imported Container<T>", () => {
    const { dir, bPath } = setupTwoFiles(
      `export type Container<T> = { value: T }\n`,
      `import { Container } from "./a.agency"\n` +
        `\nnode main() {\n  let c: Container<string> = { value: 42 }\n  print(c.value)\n}\n`,
    );
    try {
      const errors = errorsFromFile(
        bPath,
        `import { Container } from "./a.agency"\n` +
          `\nnode main() {\n  let c: Container<string> = { value: 42 }\n  print(c.value)\n}\n`,
      );
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
