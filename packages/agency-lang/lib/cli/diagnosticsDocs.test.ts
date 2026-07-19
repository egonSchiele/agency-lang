import { describe, it, expect } from "vitest";
import { generateDiagnosticsPages } from "./diagnosticsDocs.js";
import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
} from "@/typeChecker/diagnostics.js";

const pages = generateDiagnosticsPages();
const byPath = Object.fromEntries(pages.map((p) => [p.relPath, p.contents]));
// Retired diagnostics keep their registry entry (the code stays reserved,
// `agency explain` still answers) but are omitted from the docs pages.
const activeEntries = Object.values(DIAGNOSTICS).filter(
  (e) => !("retired" in e),
);
const codes = activeEntries.map((e) => e.code);

describe("generateDiagnosticsPages", () => {
  it("emits index.md plus one page per category", () => {
    expect(byPath["index.md"]).toBeTruthy();
    for (const cat of DIAGNOSTIC_CATEGORIES) {
      expect(byPath[`${cat.slug}.md`], cat.slug).toBeTruthy();
    }
  });

  it("index links every code exactly once", () => {
    // Count LINK occurrences, not raw substring: the intro prose contains a
    // legitimate `agency explain AG2005` example, so a bare-substring count
    // would read 2. The invariant is one table-row link per code.
    const index = byPath["index.md"];
    for (const code of codes) {
      expect(index.split(`[${code}](`).length - 1, code).toBe(1);
    }
  });

  it("each code appears on exactly its own category page", () => {
    for (const entry of activeEntries) {
      const cat = categoryForCode(entry.code)!;
      const page = byPath[`${cat.slug}.md`];
      expect(page.includes(`## ${entry.code}`), `${entry.code} on ${cat.slug}`).toBe(true);
      for (const other of DIAGNOSTIC_CATEGORIES) {
        if (other.slug === cat.slug) continue;
        expect(byPath[`${other.slug}.md`].includes(`## ${entry.code}`)).toBe(false);
      }
    }
  });

  it("every index link resolves to an explicit anchor on its category page", () => {
    // VitePress slugifies headings from full text, so the index's #ag#### must
    // land on an explicit <a id="ag####"> we emit, not on the heading itself.
    const index = byPath["index.md"];
    const links = [...index.matchAll(/\]\((\S+?\.md)#(\S+?)\)/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, file, anchor] of links) {
      const page = byPath[file];
      expect(page, `linked page missing: ${file}`).toBeTruthy();
      expect(page.includes(`<a id="${anchor}"></a>`), `${file}#${anchor}`).toBe(true);
    }
  });

  it("emits no `{{` — VitePress would parse it as a Vue interpolation", () => {
    // The docs are built by VitePress (Vue), which reads `{{ … }}` as a
    // template expression and hard-fails the build. Message templates use it
    // as the literal-brace escape, so the generator must neutralize it.
    for (const { relPath, contents } of pages) {
      expect(contents.includes("{{"), relPath).toBe(false);
    }
  });

  it("has unique heading anchors within each page", () => {
    for (const { contents } of pages) {
      const headings = [...contents.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(new Set(headings).size).toBe(headings.length);
    }
  });
});
