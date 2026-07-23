import { describe, it, expect } from "vitest";
import { parseAgency } from "../../parser.js";
import type { LintContext } from "../types.js";
import { unusedImportsRule } from "./unusedImports.js";

// Parse WITHOUT the template so offsets index `source` (docs/dev/locations.md).
function ctxFor(source: string): LintContext {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error("test source did not parse");
  return { program: parsed.result, source, filePath: "/test.agency" };
}

function names(source: string): string[] {
  return unusedImportsRule.run(ctxFor(source)).map((f) => {
    const m = f.message.match(/'(\w+)'/);
    return m ? m[1] : "";
  });
}

describe("unused-imports rule: detection", () => {
  it("never reports a template's hole specifier as unused", () => {
    // `#tool` is an identifier hole (template file); it binds nothing, so
    // the unused-imports rule must skip it rather than flag or crash.
    expect(names(`import { #tool } from "std::fs"\n\nnode main() { return 1 }\n`))
      .toEqual([]);
  });

  it("flags an import that is never referenced", () => {
    expect(names(`import { now } from "std::date"\nnode main() { return 1 }\n`))
      .toEqual(["now"]);
  });

  it("does not flag an import used in a call", () => {
    expect(names(`import { now } from "std::date"\nnode main() { return now() }\n`))
      .toEqual([]);
  });

  it("does not flag an import used as a value", () => {
    expect(names(`import { now } from "std::date"\nnode main() { const f = now\n  return f() }\n`))
      .toEqual([]);
  });

  it("does not flag an import used only as a bare type annotation (typeAliasVariable)", () => {
    expect(names(`import { Config } from "./types.agency"\ndef f(x: Config): number { return 1 }\n`))
      .toEqual([]);
  });

  it("does not flag an import used only as a parameterized type (genericType)", () => {
    expect(names(`import { Box } from "./types.agency"\ndef f(x: Box<number>): number { return 1 }\n`))
      .toEqual([]);
  });

  it("does not flag an aliased import that is used by its local name", () => {
    expect(names(`import { now as clock } from "std::date"\nnode main() { return clock() }\n`))
      .toEqual([]);
  });

  it("flags an aliased import that is never used", () => {
    expect(names(`import { now as clock } from "std::date"\nnode main() { return 1 }\n`))
      .toEqual(["clock"]);
  });

  it("keeps an import when a local of the same name is present (conservative)", () => {
    expect(names(`import { now } from "std::date"\nnode main() { const now = 5\n  return now }\n`))
      .toEqual([]);
  });

  it("never flags std::index imports (the injected prelude)", () => {
    expect(names(`import { map } from "std::index"\nnode main() { return 1 }\n`))
      .toEqual([]);
  });

  it("never flags a testOnly import", () => {
    expect(names(`import test { secret } from "./helpers.agency"\nnode main() { return 1 }\n`))
      .toEqual([]);
  });

  it("flags an unused import node", () => {
    expect(names(`import node { greet } from "./other.agency"\nnode main() { return 1 }\n`))
      .toEqual(["greet"]);
  });

  it("flags every unused name when a statement has more than one", () => {
    expect(names(`import { a, b, c } from "./x.agency"\nnode main() { return a() }\n`))
      .toEqual(["b", "c"]);
  });

  it("reports each finding at its own source range, even for names that are substrings of other names", () => {
    const source = `import { ab, b } from "./x.agency"\nnode main() { return ab() }\n`;
    const findings = unusedImportsRule.run(ctxFor(source));
    expect(findings).toHaveLength(1);
    // Word-boundary matching: the range must be the standalone `b`, not the
    // `b` inside `ab`.
    expect(source.slice(findings[0].loc.start, findings[0].loc.end)).toBe("b");
    expect(findings[0].loc.start).toBeGreaterThan(source.indexOf("ab") + 1);
  });
});

describe("unused-imports rule: at-risk used positions are kept", () => {
  it("keeps an import used only as a named handler (functionRef, no type field)", () => {
    const src = [
      `import { myHandler } from "./handlers.agency"`,
      `node main() {`,
      `  handle { print(1) } with myHandler`,
      `}`,
      ``,
    ].join("\n");
    expect(names(src)).toEqual([]);
  });

  it("keeps an import node used only as a goto target", () => {
    const src = [
      `import node { second } from "./other.agency"`,
      `node main() {`,
      `  goto second()`,
      `}`,
      ``,
    ].join("\n");
    expect(names(src)).toEqual([]);
  });

  it("flags an unused import named after an Object.prototype key", () => {
    expect(names(`import { constructor } from "./x.agency"\nnode main() { return 1 }\n`))
      .toEqual(["constructor"]);
  });
});
