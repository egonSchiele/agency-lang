import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function errorsFrom(source: string): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-attach-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, {});
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(
      parseResult.result,
      symbolTable,
      absPath,
      source,
    );
    return typeCheck(parseResult.result, {}, info).errors;
  } finally {
    unlinkSync(file);
  }
}

const IMPORT = `import { image, file } from "std::thread"\n`;

describe("llm() multimodal first-arg typing", () => {
  it("accepts a plain string", () => {
    expect(
      errorsFrom(`node main() { let r: string = llm("hi")\n print(r) }`),
    ).toHaveLength(0);
  });

  it("accepts a mixed text + attachment array", () => {
    expect(
      errorsFrom(
        `${IMPORT}node main() { let r: string = llm(["hi", image("x"), file("y")])\n print(r) }`,
      ),
    ).toHaveLength(0);
  });

  it("accepts an array bound to a local first (inference path)", () => {
    expect(
      errorsFrom(
        `${IMPORT}node main() { let arr = ["hi", image("x")]\n let r: string = llm(arr)\n print(r) }`,
      ),
    ).toHaveLength(0);
  });

  it("rejects a number element in the array", () => {
    expect(
      errorsFrom(`node main() { let r: string = llm([42])\n print(r) }`).length,
    ).toBeGreaterThan(0);
  });

  it("accepts a mixed array on userMessage()", () => {
    expect(
      errorsFrom(
        `import { userMessage, image } from "std::thread"\nnode main() { userMessage(["hi", image("x")]) }`,
      ),
    ).toHaveLength(0);
  });

  it("rejects a number element on userMessage()", () => {
    expect(
      errorsFrom(
        `import { userMessage } from "std::thread"\nnode main() { userMessage([42]) }`,
      ).length,
    ).toBeGreaterThan(0);
  });
});
