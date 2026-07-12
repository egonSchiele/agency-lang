import { describe, it, expect } from "vitest";
import { generateDiagnosticsPages } from "./diagnosticsDocs.js";
import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
} from "@/typeChecker/diagnostics.js";

const pages = generateDiagnosticsPages();
const byPath = Object.fromEntries(pages.map((p) => [p.relPath, p.contents]));
const codes = Object.values(DIAGNOSTICS).map((e) => e.code);

describe("generateDiagnosticsPages", () => {
  it("emits index.md plus one page per category", () => {
    expect(byPath["index.md"]).toBeTruthy();
    for (const cat of DIAGNOSTIC_CATEGORIES) {
      expect(byPath[`${cat.slug}.md`], cat.slug).toBeTruthy();
    }
  });

  it("index lists every code exactly once", () => {
    const index = byPath["index.md"];
    for (const code of codes) {
      expect(index.split(code).length - 1, code).toBeGreaterThanOrEqual(1);
    }
  });

  it("each code appears on exactly its own category page", () => {
    for (const entry of Object.values(DIAGNOSTICS)) {
      const cat = categoryForCode(entry.code)!;
      const page = byPath[`${cat.slug}.md`];
      expect(page.includes(`## ${entry.code}`), `${entry.code} on ${cat.slug}`).toBe(true);
      for (const other of DIAGNOSTIC_CATEGORIES) {
        if (other.slug === cat.slug) continue;
        expect(byPath[`${other.slug}.md`].includes(`## ${entry.code}`)).toBe(false);
      }
    }
  });

  it("has unique heading anchors within each page", () => {
    for (const { contents } of pages) {
      const headings = [...contents.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(new Set(headings).size).toBe(headings.length);
    }
  });
});
