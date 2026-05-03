import { describe, it, expect } from "vitest";
import { resolveTypeAtPosition } from "./typeResolution.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "../symbolTable.js";
import { typeCheck } from "../typeChecker/index.js";

function getTypeAtPos(source: string, line: number, character: number) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed");
  const program = r.result;
  const info = buildCompilationUnit(program, new SymbolTable());
  const { scopes } = typeCheck(program, {}, info);
  return resolveTypeAtPosition(source, line, character, program, scopes);
}

describe("resolveTypeAtPosition", () => {
  it("resolves type of a typed variable", () => {
    const source = 'node main() {\n  let x: string = "hi"\n  print(x)\n}';
    const result = getTypeAtPos(source, 2, 8);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("primitiveType");
  });

  it("returns null when not on a variable", () => {
    const source = "node main() {\n  let x: number = 1\n}";
    const result = getTypeAtPos(source, 1, 8);
    expect(result).toBeNull();
  });

  it("resolves correct scope when multiple functions exist", () => {
    const source = 'def foo() {\n  let x: number = 1\n}\ndef bar() {\n  let x: string = "hi"\n}';
    const result = getTypeAtPos(source, 4, 6);
    expect(result).not.toBeNull();
    if (result && result.type === "primitiveType") {
      expect(result.value).toBe("string");
    }
  });
});
