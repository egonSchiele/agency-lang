import { describe, it, expect } from "vitest";
import {
  _loadTemplateFromString,
  _parseExpr,
  _parseStatements,
  _toSource,
} from "../../stdlib/template.js";
import { _parseAST } from "../../stdlib/agency.js";
import { fillHoles } from "./fill.js";
import { maxHygieneIndex } from "./hygiene.js";

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

  it("a def that rebinds a renamed global keeps its own binding", () => {
    // Reaches applyScopedRenames' shadowing filter: a GLOBAL binder gets
    // renamed, and a def that rebinds the same name must be left alone —
    // its own binding shadows the outer rename. (Sibling-def tests never
    // reach the filter, because a scope-owned rename is not active when
    // the walk enters an unrelated scope.)
    const src = [
      "const tmp = getApiKey()",
      "",
      "def inner(): number {",
      "  const tmp = 5",
      "  return tmp",
      "}",
      "",
      "node main() {",
      "  const r = #e",
      "  return r",
      "}",
    ].join("\n") + "\n";
    const out = fillAndPrint(src, { e: _parseExpr("tmp") });
    expect(out).toMatch(/const tmp = 5/);
    expect(out).toMatch(/return tmp\b/);
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

  it("renames when the filler's free name arrives through an `is` expression", () => {
    // The flagship capture routed through a different operand position:
    // walkNodes originally skipped isExpression operands, so this filler
    // captured the API key with no rename and no error.
    const source = `node main() {\n  const tmp = getApiKey()\n  const leak: boolean = #e\n  return leak\n}\n`;
    const out = fillAndPrint(source, { e: _parseExpr("tmp is string") });
    expect(out).toContain("__hyg");
    expect(out).not.toMatch(/const tmp = getApiKey/);
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

  // Pre-existing __hyg names are TOLERATED, never collided with: the
  // fresh-name counter seeds above the highest index present. Rejection
  // was tried first and broke composition — a second fill rejected the
  // first fill's own renames.
  it("composes when the first fill renames", () => {
    const tpl = load(
      `node main() {\n  const tmp = 1\n  const a: boolean = #e\n  const b: number = #later\n  return b\n}\n`,
    );
    const once = fillHoles(tpl, { e: _parseExpr("tmp") }); // renames tmp
    expect(_toSource(once)).toContain("__hyg1_tmp");
    expect(() => fillHoles(once, { later: 2 })).not.toThrow();
  });

  it("seeds fresh names above a template's existing __hyg binders", () => {
    // Template already contains __hyg7_x (as a previous fill would leave);
    // a new collision-triggered rename must not reuse index <= 7.
    const source = `node main() {\n  const __hyg7_x = 1\n  const tmp = getApiKey()\n  const r = #e\n  print(r)\n}\n`;
    const out = fillAndPrint(source, { e: _parseExpr("tmp") });
    expect(out).toContain("const __hyg7_x = 1"); // untouched
    expect(out).toMatch(/const __hyg8_tmp = getApiKey/); // seeded past 7
  });

  it("seeds past __hyg declaration names in fillers", () => {
    // fresh() must not produce __hyg1_* when a filler already declares it.
    const out = fillAndPrint(
      `node main() {\n  const tmp = 1\n  #s\n  print(tmp)\n}\n`,
      { s: _parseStatements("const __hyg1_q = 2\nconst tmp = 3") },
    );
    // The filler's redeclared tmp renames to an index above 1.
    expect(out).toMatch(/const __hyg2_tmp = 3/);
    expect(out).toContain("const __hyg1_q = 2");
  });

  // Identifier fillers are plain caller strings the seed scan cannot see,
  // so the reserved prefix stays rejected on that one path.
  it("still rejects a reserved-prefix identifier filler", () => {
    expect(() =>
      fillHoles(load(`def #name(): number {\n  return 1\n}\n`), {
        name: "__hyg1_x",
      }),
    ).toThrow(/reserved/);
  });
});

describe("pattern binders", () => {
  it("a template destructuring binder colliding with a filler free name is renamed, shorthand expanded", () => {
    // Template binds `key` via shorthand destructuring; filler uses a free
    // `key`. Renaming the shorthand in place would change which property
    // is read, so it must expand to `key: freshName`.
    const source = `node main() {\n  const { key } = getSecrets()\n  const result = #userExpr\n  print(key)\n}\n`;
    const out = fillAndPrint(source, { userExpr: _parseExpr("key + 1") });
    expect(out).toMatch(/const \{ key: __hyg\d+_key \} = getSecrets\(\)/);
    expect(out).toMatch(/const result = key \+ 1/);
    expect(out).toMatch(/print\(__hyg\d+_key\)/);
  });

  it("a filler destructuring binder colliding with a visible template binder is renamed", () => {
    const source = `node main() {\n  const tmp = 1\n  #steps\n  print(tmp)\n}\n`;
    const out = fillAndPrint(source, {
      steps: _parseStatements("const { tmp } = load()\nprint(tmp)"),
    });
    // Filler binder renamed (with shorthand expansion); template untouched.
    expect(out).toMatch(/const \{ tmp: __hyg\d+_tmp \} = load\(\)/);
    expect(out).toContain("const tmp = 1");
  });

  it("array-pattern and rest binders participate in collisions", () => {
    const source = `node main() {\n  const [a, ...rest] = items()\n  const x = #v\n  print(rest)\n}\n`;
    const out = fillAndPrint(source, { v: _parseExpr("rest") });
    expect(out).toMatch(/const \[a, \.\.\.__hyg\d+_rest\] = items\(\)/);
    expect(out).toMatch(/const x = rest\b/);
    expect(out).toMatch(/print\(__hyg\d+_rest\)/);
  });

  it("a for-loop destructuring binder participates in collisions", () => {
    const source = `node main() {\n  for ({ name } in people()) {\n    const x = #v\n    print(name)\n  }\n}\n`;
    const out = fillAndPrint(source, { v: _parseExpr("name") });
    expect(out).toMatch(/for \(\{ name: __hyg\d+_name \} in people\(\)\)/);
    expect(out).toMatch(/const x = name\b/);
  });

  it("a comprehension binder participates in collisions", () => {
    const source = `node main() {\n  const doubled = [n * 2 for n in nums()]\n  const x = #v\n  print(doubled)\n}\n`;
    const out = fillAndPrint(source, { v: _parseExpr("n") });
    expect(out).toMatch(/__hyg\d+_n \* 2 for __hyg\d+_n in nums\(\)/);
    expect(out).toMatch(/const x = n\b/);
  });

  it("maxHygieneIndex sees __hyg names inside patterns (seeding)", () => {
    const code = load(`node main() {\n  const { k: __hyg7_k } = load()\n  return __hyg7_k\n}\n`);
    expect(maxHygieneIndex(code)).toBe(7);
  });

  it("an inner def that destructures a name stops an outer rename at its door (shadowing)", () => {
    const source = [
      "const tmp = 1",
      "",
      "def inner(): number {",
      "  const { tmp } = load()",
      "  return tmp",
      "}",
      "",
      "node main() {",
      "  const x = #v",
      "  return tmp",
      "}",
      "",
    ].join("\n");
    const out = fillAndPrint(source, { v: _parseExpr("tmp") });
    // The global tmp is renamed; inner destructured tmp shadows and stays.
    expect(out).toContain("const { tmp } = load()");
    expect(out).toMatch(/const __hyg\d+_tmp = 1/);
  });
});
