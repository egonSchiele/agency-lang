import { describe, it, expect } from "vitest";
import { DIAGNOSTICS, type DiagnosticName } from "./diagnostics.js";
import { DIAGNOSTIC_EXPLANATIONS } from "./diagnosticExplanations.js";
import { parseAgency } from "../parser.js";

const names = Object.keys(DIAGNOSTICS) as DiagnosticName[];

describe("diagnostic explanations", () => {
  it("has one entry per diagnostic (exhaustive)", () => {
    // The Record type guarantees this at compile time; this pins it at
    // runtime and guards against an accidental `as any` cast.
    for (const name of names) {
      expect(DIAGNOSTIC_EXPLANATIONS[name], `missing explanation: ${name}`).toBeTruthy();
    }
    expect(Object.keys(DIAGNOSTIC_EXPLANATIONS).sort()).toEqual([...names].sort());
  });

  it("every explanation is substantial (no stubs)", () => {
    for (const name of names) {
      expect(DIAGNOSTIC_EXPLANATIONS[name].trim().length, name).toBeGreaterThanOrEqual(100);
    }
  });

  it("no explanation leaks a TS interpolation", () => {
    for (const name of names) {
      expect(DIAGNOSTIC_EXPLANATIONS[name], name).not.toContain("${");
    }
  });

  it("no unrendered {placeholder} outside a code span", () => {
    // Reuse the registry's brace rule: strip fenced/inline code, then any
    // remaining {word} is an accidental raw-template quote.
    for (const name of names) {
      const withoutCode = DIAGNOSTIC_EXPLANATIONS[name]
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]*`/g, "");
      const withoutEscapes = withoutCode.replace(/\{\{|\}\}/g, "");
      expect(withoutEscapes.replace(/\{\w+\}/g, ""), name).not.toMatch(/[{}]/);
    }
  });

  it("every ```agency fenced snippet parses", () => {
    for (const name of names) {
      const blocks = extractAgencyBlocks(DIAGNOSTIC_EXPLANATIONS[name]);
      for (const block of blocks) {
        expect(() => parseAgency(block), `${name} snippet failed to parse`).not.toThrow();
      }
    }
  });
});

function extractAgencyBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```agency\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}
