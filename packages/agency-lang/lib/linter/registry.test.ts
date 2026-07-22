import { it, expect } from "vitest";
import { runLinter, lintSource, LINT_RULES } from "./registry.js";
import { parseAgency } from "../parser.js";

it("registry includes the unused-imports rule", () => {
  expect(LINT_RULES.map((r) => r.name)).toContain("unusedImport");
});

it("lintSource parses and reports findings", () => {
  const source = `import { now } from "std::date"\nnode main() { return 1 }\n`;
  const findings = lintSource(source, "/test.agency", {});
  expect(findings).toHaveLength(1);
  expect(findings[0].code).toBe("AL0001");
});

it("lintSource returns [] for source that does not parse", () => {
  expect(lintSource("def foo( {", "/bad.agency", {})).toEqual([]);
});

it("runLinter accepts an already-parsed context", () => {
  const source = `import { now } from "std::date"\nnode main() { return now() }\n`;
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error("did not parse");
  const findings = runLinter({ program: parsed.result, source, filePath: "/t.agency" });
  expect(findings).toEqual([]);
});
