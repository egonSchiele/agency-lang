import { describe, it, expect } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";

/** Codes reported for `source`, errors and warnings alike. */
function codesOf(source: string): string[] {
  const report = typeCheckSource(source);
  return [...report.errors, ...report.warnings].map((diag) => diag.code ?? "");
}

/** The first diagnostic carrying `code`, or undefined. */
function diagFor(source: string, code: string) {
  const report = typeCheckSource(source);
  return [...report.errors, ...report.warnings].find((diag) => diag.code === code);
}

describe("AG3017: statements that cannot sit at the top level", () => {
  const refused: [string, string, string][] = [
    ["if", "if (true) {\n  print(1)\n}\n\nnode main() { print(2) }\n", "AG3017"],
    ["while", "while (false) {\n  print(1)\n}\n\nnode main() { print(2) }\n", "AG3017"],
    ["for", "for (x in [1, 2]) {\n  print(x)\n}\n\nnode main() { print(2) }\n", "AG3017"],
    ["match", "match(1) {\n  1 => print(1)\n}\n\nnode main() { print(2) }\n", "AG3017"],
    ["thread", "thread {\n  print(1)\n}\n\nnode main() { print(2) }\n", "AG3017"],
    // The row the spec's first draft got wrong, and the one where a wrong
    // fix is worst: a handler that compiles and never registers.
    [
      "handle",
      "handle {\n  print(1)\n} with (e) {\n  return approve()\n}\n\nnode main() { print(2) }\n",
      "AG3018",
    ],
    ["return", "return 1\n\nnode main() { print(2) }\n", "AG3017"],
    ["interrupt", 'interrupt("x")\n\nnode main() { print(2) }\n', "AG3017"],
    ["static interrupt", 'static interrupt("x")\n\nnode main() { print(2) }\n', "AG3017"],
    ["debugger(...)", 'debugger("x")\n\nnode main() { print(2) }\n', "AG3017"],
  ];

  for (const [label, source, code] of refused) {
    it(`refuses ${label}`, () => {
      expect(codesOf(source), label).toContain(code);
    });
  }

  const allowed: [string, string][] = [
    ["const", "const x = 1\n\nnode main() { print(x) }\n"],
    ["bare call", "print(1)\n\nnode main() { print(2) }\n"],
    ["static call", "static print(1)\n\nnode main() { print(2) }\n"],
    ["assignment", "x = 1\n\nnode main() { print(2) }\n"],
    ["bare debugger", "debugger\n\nnode main() { print(2) }\n"],
    ["declarations", "def f(): number {\n  return 1\n}\n\nnode main() { print(2) }\n"],
    ["goto, which is two bare names", "goto other\n\nnode main() { print(2) }\n"],
  ];

  for (const [label, source] of allowed) {
    it(`allows ${label}`, () => {
      const codes = codesOf(source).filter((c) => c === "AG3017" || c === "AG3018");
      expect(codes, label).toEqual([]);
    });
  }

  it("names the rule, not just the symptom", () => {
    const found = diagFor("if (true) {\n  print(1)\n}\n\nnode main() { print(2) }\n", "AG3017");
    expect(found?.message).toMatch(/top level/);
    expect(found?.message).toMatch(/initializ/i);
  });

  it("describes the inner statement of a static, not the wrapper", () => {
    const found = diagFor('static interrupt("x")\n\nnode main() { print(2) }\n', "AG3017");
    expect(found?.message).toMatch(/interrupt/);
    expect(found?.message).not.toMatch(/staticStatement/);
  });

  it("tells a handler author where handlers may live", () => {
    const found = diagFor(
      "handle {\n  print(1)\n} with (e) {\n  return approve()\n}\n\nnode main() { print(2) }\n",
      "AG3018",
    );
    expect(found?.message).toMatch(/handler/i);
  });

  it("reports every offender, not just the first", () => {
    const two =
      "if (true) {\n  print(1)\n}\n\nif (false) {\n  print(2)\n}\n\nnode main() { print(3) }\n";
    expect(codesOf(two).filter((c) => c === "AG3017")).toHaveLength(2);
  });

  it("carries a location, so the message can point at the statement", () => {
    const found = diagFor("if (true) {\n  print(1)\n}\n\nnode main() { print(2) }\n", "AG3017");
    expect(found?.loc).toBeDefined();
    expect(found?.loc?.line).toBeGreaterThanOrEqual(0);
  });
});
