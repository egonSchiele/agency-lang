import { describe, it, expect } from "vitest";
import { parseAgency } from "../../parser.js";
import { lintSource } from "../registry.js";
import type { LintContext, LintFinding } from "../types.js";
import { redundantPreludeImportRule } from "./redundantPreludeImport.js";

function ctxFor(source: string): LintContext {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error("test source did not parse");
  return { program: parsed.result, source, filePath: "/test.agency" };
}

function names(source: string): string[] {
  return redundantPreludeImportRule.run(ctxFor(source)).map((f) => {
    const m = f.message.match(/'(\w+)'/);
    return m ? m[1] : "";
  });
}

function applied(source: string, f: LintFinding): string {
  let out = source;
  for (const e of [...(f.fix?.edits ?? [])].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }
  return out;
}

describe("redundant-prelude-import rule", () => {
  it("flags a prelude name imported from std::index (used or not — redundancy is not usage)", () => {
    expect(names(`import { map } from "std::index"\nnode main() { return 1 }\n`))
      .toEqual(["map"]);
  });

  it("flags each redundant name when a statement has two", () => {
    expect(names(`import { map, filter } from "std::index"\nnode main() { return 1 }\n`))
      .toEqual(["map", "filter"]);
  });

  it("keeps a std::index name that is NOT in the prelude (types like WriteMode)", () => {
    expect(names(`import { WriteMode } from "std::index"\ndef pick(m: WriteMode): WriteMode { return m }\n`))
      .toEqual([]);
  });

  it("keeps an aliased prelude import (the alias binds a new name)", () => {
    expect(names(`import { map as arrMap } from "std::index"\nnode main() { return 1 }\n`))
      .toEqual([]);
  });

  it("keeps a destructive-marked prelude import (the marker changes retry behavior)", () => {
    expect(names(`import { destructive write } from "std::index"\nnode main() { return 1 }\n`))
      .toEqual([]);
  });

  it("keeps an idempotent-marked prelude import", () => {
    expect(names(`import { idempotent write } from "std::index"\nnode main() { return 1 }\n`))
      .toEqual([]);
  });

  it("skips non-std::index imports and testOnly imports", () => {
    expect(names(`import { map } from "./mymap.agency"\nnode main() { return 1 }\n`)).toEqual([]);
    expect(names(`import test { map } from "std::index"\nnode main() { return 1 }\n`)).toEqual([]);
  });

  it("fix removes just the redundant name, keeping non-prelude names", () => {
    const src = `import { map, WriteMode } from "std::index"\ndef pick(m: WriteMode): WriteMode { return m }\n`;
    const f = redundantPreludeImportRule.run(ctxFor(src))[0];
    const out = applied(src, f);
    expect(out).toContain(`import { WriteMode } from "std::index"`);
    expect(out).not.toContain("map,");
  });

  it("with two redundant names, each individual fix removes only its own name", () => {
    const src = `import { map, filter } from "std::index"\nnode main() { return 1 }\n`;
    const [forMap] = redundantPreludeImportRule.run(ctxFor(src));
    expect(applied(src, forMap)).toContain(`import { filter } from "std::index"`);
  });

  it("fix deletes the whole statement when every name is redundant", () => {
    const src = `import { map } from "std::index"\nnode main() { return 1 }\n`;
    const f = redundantPreludeImportRule.run(ctxFor(src))[0];
    expect(applied(src, f)).toBe(`node main() { return 1 }\n`);
  });

  it("surfaces through lintSource end to end", () => {
    const findings = lintSource(`import { map } from "std::index"\nnode main() { return 1 }\n`, "/t.agency", {});
    expect(findings.map((x) => x.code)).toContain("AL0003");
  });
});
