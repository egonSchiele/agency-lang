import { it, expect } from "vitest";
import { lintSource } from "../linter/registry.js";
import { formatFindings } from "./lint.js";

it("formats a finding 1-indexed with its code", () => {
  const source = `import { now } from "std::date"\nnode main() { return 1 }\n`;
  const findings = lintSource(source, "/main.agency", {});
  expect(findings).toHaveLength(1);
  const out = formatFindings("/main.agency", findings);
  // 'now' starts at 0-indexed column 9 ("import { " is 9 chars), so the
  // 1-indexed display position is 1:10.
  expect(out).toContain("1:10");
  expect(out).toContain("AL0001");
  expect(out).toContain("now");
});

it("reports nothing for a clean file", () => {
  const source = `import { now } from "std::date"\nnode main() { return now() }\n`;
  expect(lintSource(source, "/main.agency", {})).toEqual([]);
});
