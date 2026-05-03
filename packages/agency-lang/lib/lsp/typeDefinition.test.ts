import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleTypeDefinition } from "./typeDefinition.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "../symbolTable.js";
import { typeCheck } from "../typeChecker/index.js";
import { buildSemanticIndex } from "./semantics.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

function setup(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed");
  const program = r.result;
  const doc = makeDoc(source);
  const st = new SymbolTable();
  const info = buildCompilationUnit(program, st);
  const { scopes } = typeCheck(program, {}, info);
  const semanticIndex = buildSemanticIndex(program, "/test.agency", st);
  return { program, doc, scopes, semanticIndex };
}

describe("handleTypeDefinition", () => {
  it("jumps to type alias definition from variable", () => {
    const source = 'type Foo = { name: string }\nnode main() {\n  let x: Foo = llm("hi")\n  print(x)\n}';
    const { program, doc, scopes, semanticIndex } = setup(source);
    const result = handleTypeDefinition(
      { textDocument: { uri: doc.uri }, position: { line: 3, character: 8 } },
      doc, program, scopes, semanticIndex,
    );
    expect(result).not.toBeNull();
    expect(result!.range.start.line).toBe(0);
  });

  it("returns null for primitive types", () => {
    const source = 'node main() {\n  let x: string = "hi"\n  print(x)\n}';
    const { program, doc, scopes, semanticIndex } = setup(source);
    const result = handleTypeDefinition(
      { textDocument: { uri: doc.uri }, position: { line: 2, character: 8 } },
      doc, program, scopes, semanticIndex,
    );
    expect(result).toBeNull();
  });
});
