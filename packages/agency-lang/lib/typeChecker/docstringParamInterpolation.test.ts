import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";
import type { AgencyConfig } from "../config.js";

function errorsFrom(
  source: string,
  config: AgencyConfig = {},
): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-docstring-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, config);
    const parseResult = parseAgency(source, config);
    if (!parseResult.success) throw new Error("Parse failed");
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, config, info).errors;
  } finally {
    unlinkSync(file);
  }
}

describe("doc string parameter interpolation", () => {
  it("errors when interpolating a function parameter in a doc string", () => {
    const errors = errorsFrom(`
def greet(name: string) {
  """Greets the person \${name}."""
}
node main() {}
`);
    const relevant = errors.filter((e) =>
      e.message.includes("Cannot interpolate parameter"),
    );
    expect(relevant).toHaveLength(1);
    expect(relevant[0].message).toContain("'name'");
  });

  it("errors when interpolating a node parameter in a doc string", () => {
    const errors = errorsFrom(`
node greet(user: string) {
  """Processes \${user}."""
}
node main() {}
`);
    const relevant = errors.filter((e) =>
      e.message.includes("Cannot interpolate parameter"),
    );
    expect(relevant).toHaveLength(1);
    expect(relevant[0].message).toContain("'user'");
  });

  it("allows interpolating a global variable in a doc string", () => {
    const errors = errorsFrom(`
const version = "1.0"
def info() {
  """Version \${version}."""
}
node main() {}
`);
    const relevant = errors.filter((e) =>
      e.message.includes("Cannot interpolate parameter"),
    );
    expect(relevant).toHaveLength(0);
  });

  it("allows doc strings with no interpolation", () => {
    const errors = errorsFrom(`
def add(a: number, b: number) {
  """Adds two numbers."""
}
node main() {}
`);
    const relevant = errors.filter((e) =>
      e.message.includes("Cannot interpolate parameter"),
    );
    expect(relevant).toHaveLength(0);
  });
});
