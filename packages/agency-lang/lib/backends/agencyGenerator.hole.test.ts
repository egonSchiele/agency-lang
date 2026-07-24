import { describe, it, expect } from "vitest";
import { _parseAST } from "../stdlib/agency.js";
import { generateAgency } from "./agencyGenerator.js";
import { _loadTemplateFromString, _toSource } from "../stdlib/template.js";
import { fillHoles } from "../runtime/template/fill.js";

export function roundTrip(source: string): string {
  return generateAgency(_parseAST(source));
}

describe("generateAgency: holes", () => {
  it("prints a bare hole", () => {
    expect(roundTrip(`node main() {\n  const x = #prompt\n}\n`)).toContain("#prompt");
  });

  it("prints an annotated hole", () => {
    expect(roundTrip(`node main() {\n  const x = #p: string\n}\n`)).toContain("#p: string");
  });

  it("prints a compound annotation", () => {
    expect(roundTrip(`node main() {\n  const x = #p: string[] | null\n}\n`)).toContain(
      "#p: string[] | null",
    );
  });

  // The one that catches real bugs: a generator that prints something
  // parseable but different passes the tests above and fails this one.
  it("is stable across two round trips", () => {
    const once = roundTrip(`node main() {\n  const x = #prompt\n}\n`);
    expect(roundTrip(once)).toBe(once);
  });

  it("round-trips a statement hole", () => {
    const once = roundTrip(`node main() {\n  #setup\n}\n`);
    expect(once).toContain("#setup");
    expect(roundTrip(once)).toBe(once);
  });

  it("a filled template prints and re-parses identically", () => {
    const filled = fillHoles(
      _loadTemplateFromString(`node main() {\n  const x = #v: number\n}\n`),
      { v: 1 },
    );
    const once = _toSource(filled);
    expect(generateAgency(_parseAST(once))).toBe(once);
  });

  it("round-trips a splice", () => {
    const once = roundTrip(`node main() {\n  #...steps\n}\n`);
    expect(once).toContain("#...steps");
    expect(roundTrip(once)).toBe(once);
  });

  it("round-trips a quoted name, keeping the quotes", () => {
    const once = roundTrip(`node main() {\n  const x = #"hi-there"\n}\n`);
    expect(once).toContain(`#"hi-there"`);
    expect(roundTrip(once)).toBe(once);
  });

  it("round-trips an argument-list splice", () => {
    const once = roundTrip(`node main() {\n  f(#...args)\n}\n`);
    expect(once).toContain("#...args");
    expect(roundTrip(once)).toBe(once);
  });

  for (const source of [
    `def #name(): number {\n  return 1\n}\n`,
    `node #n() {\n  return 1\n}\n`,
    `import { #tool } from "std::fs"\n\nnode main() {\n  return 1\n}\n`,
    `#helpers\n\nnode main() {\n  return 1\n}\n`,
  ]) {
    it(`round-trips: ${source.split("\n")[0]}`, () => {
      const once = roundTrip(source);
      expect(roundTrip(once)).toBe(once);
    });
  }
});
