import { describe, it, expect } from "vitest";
import { InlayHintKind } from "vscode-languageserver-protocol";
import { getInlayHints } from "./inlayHint.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "../symbolTable.js";
import { typeCheck } from "../typeChecker/index.js";

function setup(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed");
  const program = r.result;
  const info = buildCompilationUnit(program, new SymbolTable());
  const { scopes } = typeCheck(program, {}, info);
  return { program, scopes };
}

describe("getInlayHints", () => {
  it("shows inferred type for untyped variable", () => {
    const { program, scopes } = setup("node main() {\n  let x = 5\n}");
    const hints = getInlayHints(program, scopes);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    const hint = hints.find((h) => h.label === ": number");
    expect(hint).toBeDefined();
    expect(hint!.kind).toBe(InlayHintKind.Type);
  });

  it("does not show hint for explicitly typed variable", () => {
    const { program, scopes } = setup("node main() {\n  let x: number = 5\n}");
    const hints = getInlayHints(program, scopes);
    const hint = hints.find((h) => h.position.line === 1);
    expect(hint).toBeUndefined();
  });

  it("positions hint after variable name", () => {
    const { program, scopes } = setup("node main() {\n  let foo = 5\n}");
    const hints = getInlayHints(program, scopes);
    const hint = hints.find((h) => h.label === ": number");
    expect(hint).toBeDefined();
    // "  let foo" => col 2 for "let", variable name "foo" starts at 6, ends at 9
    expect(hint!.position.character).toBe(9);
  });
});
