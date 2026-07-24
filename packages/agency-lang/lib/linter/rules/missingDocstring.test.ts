import { describe, it, expect } from "vitest";
import { parseAgency } from "../../parser.js";
import { lintSource } from "../registry.js";
import type { LintContext } from "../types.js";
import { missingDocstringRule } from "./missingDocstring.js";

function ctxFor(source: string): LintContext {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error("test source did not parse");
  return { program: parsed.result, source, filePath: "/test.agency" };
}

function names(source: string): string[] {
  return missingDocstringRule.run(ctxFor(source)).map((f) => {
    const m = f.message.match(/'(\w+)'/);
    return m ? m[1] : "";
  });
}

describe("missing-docstring rule", () => {
  it("flags an exported function without a docstring", () => {
    expect(names(`export def fetchUser(id: string): string { return id }\n`))
      .toEqual(["fetchUser"]);
  });

  it("does not flag an exported function with a docstring", () => {
    const src = [
      `export def fetchUser(id: string): string {`,
      `  """`,
      `  Fetch a user record by id.`,
      `  """`,
      `  return id`,
      `}`,
      ``,
    ].join("\n");
    expect(names(src)).toEqual([]);
  });

  it("does not flag a private function", () => {
    expect(names(`def helper(x: number): number { return x }\n`)).toEqual([]);
  });

  it("does not flag exported nodes (docstrings only reach agency doc)", () => {
    expect(names(`export node main() { return 1 }\n`)).toEqual([]);
  });

  it("a standalone comment above the function is not a docstring", () => {
    // The `//` line parses as a sibling `comment` node; the function's
    // docString stays unset, so the finding remains. (The AST's docComment
    // field is populated only by the TypescriptPreprocessor, which the
    // linter never runs — the rule needs no docComment logic at all.)
    const src = [
      `// Fetches a user. This comment never reaches the LLM.`,
      `export def fetchUser(id: string): string { return id }`,
      ``,
    ].join("\n");
    expect(names(src)).toEqual(["fetchUser"]);
  });

  it("anchors the finding on the function name token, with no fix", () => {
    const src = `export def fetchUser(id: string): string { return id }\n`;
    const f = missingDocstringRule.run(ctxFor(src))[0];
    expect(src.slice(f.loc.start, f.loc.end)).toBe("fetchUser");
    expect(f.fix).toBeUndefined();
  });

  it("surfaces through lintSource end to end", () => {
    const findings = lintSource(`export def f(): number { return 1 }\n`, "/t.agency", {});
    expect(findings.map((x) => x.code)).toContain("AL0002");
  });
});
