import { describe, it, expect } from "vitest";
import {
  _loadTemplateFromString,
  _parseExpr,
  _parseStatements,
  _toSource,
} from "../../stdlib/template.js";
import { _parseAST } from "../../stdlib/agency.js";
import { fillHoles } from "./fill.js";

const load = _loadTemplateFromString;

function fillAndPrint(source: string, values: Record<string, unknown>): string {
  return _toSource(fillHoles(load(source), values));
}

describe("hygiene", () => {
  const capture = `node main() {\n  const tmp = getApiKey()\n  const result = #userExpr\n  print(result)\n}\n`;

  it("renames the template binder when a filler uses that name", () => {
    const out = fillAndPrint(capture, { userExpr: _parseExpr("tmp") });
    expect(out).toContain("__hyg");
    expect(out).not.toMatch(/const tmp = getApiKey/);
  });

  it("leaves non-colliding names alone", () => {
    const out = fillAndPrint(capture, { userExpr: _parseExpr("42") });
    expect(out).toContain("const tmp = getApiKey()");
    expect(out).not.toContain("__hyg");
  });

  it("gives two colliding fillers distinct fresh names", () => {
    const out = fillAndPrint(`node main() {\n  #setup\n  #cleanup\n}\n`, {
      setup: _parseStatements("const tmp = 1"),
      cleanup: _parseStatements("const tmp = 2"),
    });
    const names = [...out.matchAll(/const (\w+) =/g)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2); // distinct — not both __hyg1_tmp
  });

  it("renames when a filler collides with a function parameter", () => {
    const out = fillAndPrint(`def f(tmp: number): number {\n  return #e\n}\n`, {
      e: _parseExpr("tmp"),
    });
    expect(out).toContain("__hyg");
  });

  it("renames when a filler collides with a for-loop binder", () => {
    const out = fillAndPrint(
      `node main() {\n  for (item in xs) {\n    print(#e)\n  }\n}\n`,
      { e: _parseExpr("item") },
    );
    expect(out).toContain("__hyg");
  });

  it("renames a filler binder that redeclares a template binder", () => {
    const source = `node main() {\n  const tmp = getApiKey()\n  #setup\n  print(tmp)\n}\n`;
    const out = fillAndPrint(source, { setup: _parseStatements("const tmp = 99") });
    // The template keeps its spelling; the filler's duplicate is renamed.
    expect(out).toContain("const tmp = getApiKey()");
    expect(out).toMatch(/const __hyg\d+_tmp = 99/);
    expect(out).toContain("print(tmp)");
  });

  it("does not rename an unrelated same-named binder in another function", () => {
    const source = `def a(): number {\n  const tmp = 1\n  return tmp\n}\n\ndef b(): number {\n  const tmp = 2\n  return #e\n}\n`;
    const out = fillAndPrint(source, { e: _parseExpr("tmp") });
    // Both directions, so this cannot pass vacuously: `def a` is untouched
    // AND `def b`'s binder actually got renamed.
    expect(out).toContain("const tmp = 1");
    expect(out).toContain("return tmp");
    expect(out).not.toMatch(/const tmp = 2/);
    expect(out).toMatch(/const __hyg\d+_tmp = 2/);
  });

  it("produces names that re-parse", () => {
    const out = fillAndPrint(capture, { userExpr: _parseExpr("tmp") });
    expect(() => _parseAST(out)).not.toThrow();
  });

  it("keeps a renamed filler internally consistent", () => {
    const source = `node main() {\n  const tmp = getApiKey()\n  #setup\n  print(tmp)\n}\n`;
    const out = fillAndPrint(source, {
      setup: _parseStatements("const tmp = 99\nprint(tmp)"),
    });
    // The filler's own use of tmp follows its binder's rename.
    const renamed = out.match(/const (__hyg\d+_tmp) = 99/)?.[1];
    expect(renamed).toBeTruthy();
    expect(out).toContain(`print(${renamed})`);
    // And the template's own print(tmp) still refers to the original.
    expect(out).toContain("print(tmp)");
  });

  it("rejects a template using the reserved prefix", () => {
    const source = `node main() {\n  const __hyg1_x = 1\n  const y = #v\n}\n`;
    expect(() => fillHoles(load(source), { v: 1 })).toThrow(/reserved/);
  });

  it("rejects a filler using the reserved prefix", () => {
    expect(() =>
      fillHoles(load(`node main() {\n  #s\n}\n`), {
        s: _parseStatements("const __hyg1_x = 1"),
      }),
    ).toThrow(/reserved/);
  });

  // Declaration names must be covered too: fresh() starts at __hyg1_, so a
  // filler declaring `def __hyg1_tmp()` could collide with the very first
  // rename if declarations went unchecked.
  it("rejects a filler declaring a function with the reserved prefix", () => {
    expect(() =>
      fillHoles(load(`#decls\n\nnode main() {\n  return 1\n}\n`), {
        decls: _parseAST("def __hyg1_x(): number {\n  return 1\n}\n"),
      }),
    ).toThrow(/reserved/);
  });

  it("rejects a filler declaring a type alias with the reserved prefix", () => {
    expect(() =>
      fillHoles(load(`#decls\n\nnode main() {\n  return 1\n}\n`), {
        decls: _parseAST("type __hyg1_T = string\n"),
      }),
    ).toThrow(/reserved/);
  });

  it("rejects a template whose node name uses the reserved prefix", () => {
    expect(() =>
      fillHoles(load(`node __hyg1_main() {\n  const x = #v\n}\n`), { v: 1 }),
    ).toThrow(/reserved/);
  });
});
