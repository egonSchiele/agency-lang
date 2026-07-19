import { describe, it, expect } from "vitest";
import path from "path";
import { _agentSkillsDir } from "./skills.js";

describe("_agentSkillsDir", () => {
  it("resolves a plain agent name under the shipped skills directory", () => {
    const dir = _agentSkillsDir("coding");
    expect(dir.endsWith(path.join("agents", "skills", "coding"))).toBe(true);
  });

  it("resolves a nested agent name", () => {
    const dir = _agentSkillsDir("agency/coding");
    expect(
      dir.endsWith(path.join("agents", "skills", "agency", "coding")),
    ).toBe(true);
  });

  // agentSkill skips the approval interrupt because the files ship in the
  // package. That argument only holds while the path cannot leave the
  // shipped directory.
  it("rejects a name that escapes the skills directory", () => {
    expect(() => _agentSkillsDir("../../..")).toThrow(/outside the shipped/);
    expect(() => _agentSkillsDir("coding/../../../etc")).toThrow(
      /outside the shipped/,
    );
  });

  it("rejects an absolute path", () => {
    expect(() => _agentSkillsDir("/etc")).toThrow(/outside the shipped/);
  });
});
