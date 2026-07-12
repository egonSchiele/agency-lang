import { describe, it, expect } from "vitest";
import { renderDiagnosticText, renderDiagnosticList } from "./explain.js";
import { DIAGNOSTICS } from "@/typeChecker/diagnostics.js";

// termcolors colors unconditionally; strip ANSI to assert on text.
// (Same pattern as lib/typeChecker/formatErrors.test.ts:10.)
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderDiagnosticText", () => {
  it("resolves a code and its registry name to the same text", () => {
    const byCode = renderDiagnosticText("AG2005");
    const byName = renderDiagnosticText("typeNotAssignable");
    expect(byCode.found).toBe(true);
    expect(plain(byCode.text)).toBe(plain(byName.text));
  });

  it("is case-insensitive on the code", () => {
    expect(renderDiagnosticText("ag2005").found).toBe(true);
  });

  it("includes the message template and the explanation", () => {
    const { text } = renderDiagnosticText("AG2005");
    expect(plain(text)).toContain(DIAGNOSTICS.typeNotAssignable.message);
    expect(plain(text)).toContain("not assignable"); // from the explanation prose
  });

  it("returns found:false with a suggestion for an unknown code", () => {
    const { text, found } = renderDiagnosticText("AG9999");
    expect(found).toBe(false);
    expect(plain(text)).toContain("AG9999");
    expect(plain(text)).toContain("agency explain --list");
  });
});

describe("renderDiagnosticList", () => {
  it("lists every code exactly once", () => {
    const listed = plain(renderDiagnosticList());
    for (const entry of Object.values(DIAGNOSTICS)) {
      const occurrences = listed.split(entry.code).length - 1;
      expect(occurrences, entry.code).toBe(1);
    }
  });
});
