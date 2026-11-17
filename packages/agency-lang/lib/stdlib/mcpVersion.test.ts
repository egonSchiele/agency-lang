import { describe, it, expect } from "vitest";
import { versionAtLeast, packageProblem } from "./mcpVersion.js";

describe("versionAtLeast", () => {
  const cases: [string, boolean][] = [
    ["0.0.6", true],
    ["0.0.5", false],
    ["0.1.0", true],
    ["1.0.0", true],
    ["0.0.10", true],
    ["0.0.6-beta.1", true],
    ["", false],
    ["abc", false],
  ];
  for (const [found, expected] of cases) {
    it(`"${found}" against 0.0.6 is ${expected}`, () => {
      expect(versionAtLeast(found, "0.0.6")).toBe(expected);
    });
  }
});

describe("packageProblem", () => {
  it("names the version and the upgrade command for an old package", () => {
    expect(packageProblem("0.0.5")).toBe(
      "@agency-lang/mcp 0.0.5 is too old. Run: npm install -g @agency-lang/mcp@latest",
    );
  });

  it("is empty for a new enough package", () => {
    expect(packageProblem("0.0.6")).toBe("");
  });
});
