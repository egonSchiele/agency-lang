import { describe, it, expect } from "vitest";
import { LINT_DIAGNOSTICS, lintDiagnostic } from "./diagnostics.js";

describe("lint diagnostics registry", () => {
  it("assigns a unique code to every entry", () => {
    const codes = Object.values(LINT_DIAGNOSTICS).map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("every code matches the AL#### shape", () => {
    for (const entry of Object.values(LINT_DIAGNOSTICS)) {
      expect(entry.code).toMatch(/^AL\d{4}$/);
    }
  });

  it("lintDiagnostic stamps the code and renders the message", () => {
    const loc = { line: 0, col: 0, start: 0, end: 3 };
    const finding = lintDiagnostic("unusedImport", { name: "foo" }, loc);
    expect(finding.code).toBe("AL0001");
    expect(finding.name).toBe("unusedImport");
    expect(finding.severity).toBe("hint");
    expect(finding.message).toBe("'foo' is imported but never used.");
    expect(finding.loc).toBe(loc);
    expect(finding.fix).toBeUndefined();
  });
});
