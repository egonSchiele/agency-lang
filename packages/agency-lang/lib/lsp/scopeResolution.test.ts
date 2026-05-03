import { describe, it, expect } from "vitest";
import { findContainingScope, findDefForScope } from "./scopeResolution.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "../symbolTable.js";
import { typeCheck } from "../typeChecker/index.js";

function getScopesAndProgram(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  const program = r.result;
  const info = buildCompilationUnit(program, new SymbolTable());
  const { scopes } = typeCheck(program, {}, info);
  return { program, scopes };
}

describe("findDefForScope", () => {
  it("finds function definition by name", () => {
    const source = "def greet(name: string): string {\n  return name\n}";
    const { program } = getScopesAndProgram(source);
    const def = findDefForScope("greet", program);
    expect(def).not.toBeNull();
    expect(def!.type).toBe("function");
  });

  it("finds node definition by name", () => {
    const source = "node main() {\n  print(1)\n}";
    const { program } = getScopesAndProgram(source);
    const def = findDefForScope("main", program);
    expect(def).not.toBeNull();
    expect(def!.type).toBe("graphNode");
  });

  it("returns null for unknown name", () => {
    const source = "def greet() {\n  print(1)\n}";
    const { program } = getScopesAndProgram(source);
    expect(findDefForScope("unknown", program)).toBeNull();
  });
});

describe("findContainingScope", () => {
  it("resolves correct scope for two adjacent functions", () => {
    const source = "def foo() {\n  let x: number = 1\n}\ndef bar() {\n  let y: string = \"hi\"\n}";
    const { program, scopes } = getScopesAndProgram(source);

    // Find offset inside bar's body (line 4: "  let y: string = ...")
    const barOffset = source.indexOf('let y');
    const barScope = findContainingScope(barOffset, scopes, program);
    expect(barScope).toBeDefined();
    expect(barScope!.name).toBe("bar");

    // Find offset inside foo's body
    const fooOffset = source.indexOf('let x');
    const fooScope = findContainingScope(fooOffset, scopes, program);
    expect(fooScope).toBeDefined();
    expect(fooScope!.name).toBe("foo");
  });

  it("falls back to top-level scope for code outside functions", () => {
    const source = "let x: number = 1\ndef foo() {\n  print(1)\n}";
    const { program, scopes } = getScopesAndProgram(source);

    const topOffset = 0;
    const scope = findContainingScope(topOffset, scopes, program);
    expect(scope).toBeDefined();
    expect(scope!.name).toBe("top-level");
  });
});
