import { describe, expect, it } from "vitest";
import { DIAGNOSTICS, renderMessage, type DiagnosticName } from "./diagnostics.js";

/**
 * The param set each splice diagnostic's raiser must supply.
 *
 * renderMessage throws on a missing param rather than leaking a literal
 * "{effects}" into user-facing text, so the failure mode is loud — but it
 * is loud at the moment the compiler is already reporting a DIFFERENT
 * error, which is the worst possible time to discover it. Pinning the
 * contract here moves that discovery to test time, and gives Tasks 4
 * through 8 a spec for what to pass.
 */
const SPLICE_DIAGNOSTIC_PARAMS: Record<string, Record<string, string>> = {
  spliceGeneratorNotImported: { name: "makeGetters" },
  spliceGeneratorReachesNonAgency: { name: "makeGetters", importPath: "zod" },
  spliceFragmentKindMismatch: {
    name: "makeGetters",
    actual: "program",
    expected: "expr",
    position: "expression",
  },
  spliceGeneratorFailed: { name: "makeGetters", reason: "timed out after 30s" },
  spliceNested: {},
  spliceReferencesOuterName: { name: "tmp" },
  spliceGeneratedExport: { name: "makeGetters", declared: "greet" },
  spliceRedeclaresHostName: { name: "makeGetters", declared: "config" },
  spliceArgumentNotAvailable: { name: "SOME_CONST" },
  spliceGeneratorRaises: { name: "makeGetters", effects: "std::read, std::write" },
  spliceGeneratorUnreadable: {
    name: "makeGetters",
    reason: "it reaches helper.agency, which does not parse",
  },
  spliceTopLevelStatement: { name: "makeGetters", kind: "an `if` statement" },
};

describe("splice diagnostics", () => {
  it("covers every AG80xx splice code", () => {
    const spliceCodes = Object.entries(DIAGNOSTICS)
      .filter(([diagnosticName]) => diagnosticName.startsWith("splice"))
      .map(([diagnosticName]) => diagnosticName)
      .sort();
    expect(spliceCodes).toEqual(Object.keys(SPLICE_DIAGNOSTIC_PARAMS).sort());
  });

  it("assigns the splice codes", () => {
    const codes = Object.keys(SPLICE_DIAGNOSTIC_PARAMS)
      .map((diagnosticName) => DIAGNOSTICS[diagnosticName as DiagnosticName].code)
      .sort();
    expect(codes).toEqual([
      "AG8003",
      "AG8004",
      "AG8005",
      "AG8006",
      "AG8007",
      "AG8008",
      "AG8009",
      "AG8010",
      "AG8011",
      "AG8012",
      "AG8013",
      "AG8014",
    ]);
  });

  for (const [diagnosticName, params] of Object.entries(SPLICE_DIAGNOSTIC_PARAMS)) {
    it(`renders ${diagnosticName} with no unfilled placeholders`, () => {
      const rendered = renderMessage(
        DIAGNOSTICS[diagnosticName as DiagnosticName].message,
        params,
      );
      expect(rendered).not.toContain("{");
      expect(rendered).not.toContain("}");
    });
  }
});
