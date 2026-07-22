import { describe, it, expect } from "vitest";
import { parseAgency } from "../../parser.js";
import type { LintContext, LintEdit, LintFinding } from "../types.js";
import { unusedImportsRule, unusedImportsBatchEdits } from "./unusedImports.js";

function ctxFor(source: string): LintContext {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error("did not parse");
  return { program: parsed.result, source, filePath: "/test.agency" };
}

function applyEdits(source: string, edits: LintEdit[]): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }
  return out;
}

function applied(source: string, f: LintFinding): string {
  return applyEdits(source, f.fix?.edits ?? []);
}

describe("unused-imports rule: per-finding fix", () => {
  it("regenerates the statement without the unused name", () => {
    const src = `import { a, b } from "./x.agency"\nnode main() { return a() }\n`;
    const f = unusedImportsRule.run(ctxFor(src))[0];
    expect(applied(src, f)).toContain(`import { a } from "./x.agency"`);
    expect(applied(src, f)).not.toContain("b");
  });

  it("deletes the whole statement when the only name is unused", () => {
    const src = `import { a } from "./x.agency"\nnode main() { return 1 }\n`;
    const f = unusedImportsRule.run(ctxFor(src))[0];
    expect(applied(src, f)).toBe(`node main() { return 1 }\n`);
  });

  it("keeps aliases on surviving names and removes the unused alias", () => {
    const src = `import { a as x, b as y } from "./m.agency"\nnode main() { return x() }\n`;
    const f = unusedImportsRule.run(ctxFor(src))[0]; // y is unused
    const out = applied(src, f);
    expect(out).toContain("a as x");
    expect(out).not.toContain("as y");
  });

  it("removes an unused import node via regeneration", () => {
    const src = `import node { greet } from "./o.agency"\nnode main() { return 1 }\n`;
    const f = unusedImportsRule.run(ctxFor(src))[0];
    expect(applied(src, f)).toBe(`node main() { return 1 }\n`);
  });
});

describe("unused-imports rule: batch edits", () => {
  it("regenerates a statement once when it has two unused names", () => {
    const src = `import { a, b, c } from "./x.agency"\nnode main() { return a() }\n`;
    const ctx = ctxFor(src);
    const edits = unusedImportsBatchEdits(ctx);
    expect(edits).toHaveLength(1); // one edit per statement, never per name
    expect(applyEdits(src, edits)).toContain(`import { a } from "./x.agency"`);
  });

  it("deletes a statement whose names are all unused, and trims another", () => {
    const src = [
      `import { a } from "./x.agency"`,
      `import { b, c } from "./y.agency"`,
      `node main() { return c() }`,
      ``,
    ].join("\n");
    const out = applyEdits(src, unusedImportsBatchEdits(ctxFor(src)));
    expect(out).not.toContain("x.agency");
    expect(out).toContain(`import { c } from "./y.agency"`);
    expect(out).not.toContain("b,");
  });

  it("returns no edits for a clean file", () => {
    const src = `import { a } from "./x.agency"\nnode main() { return a() }\n`;
    expect(unusedImportsBatchEdits(ctxFor(src))).toEqual([]);
  });
});

describe("unused-imports rule: whole-line deletion edges", () => {
  it("preserves a blank line that follows a deleted import", () => {
    const src = [
      `import { a } from "./x.agency"`,
      ``,
      `node main() { return 1 }`,
      ``,
    ].join("\n");
    const f = unusedImportsRule.run(ctxFor(src))[0];
    expect(applied(src, f)).toBe(`\nnode main() { return 1 }\n`);
  });

  it("deletes a statement at EOF with no trailing newline", () => {
    const src = `node main() { return 1 }\nimport { a } from "./x.agency"`;
    const f = unusedImportsRule.run(ctxFor(src))[0];
    expect(applied(src, f)).toBe(`node main() { return 1 }\n`);
  });
});
