import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveResumeCarrier } from "./resumeCarrier.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveResumeCarrier", () => {
  it("resolves the checkpoint path and serializes overrides", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agency-resume-carrier-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "cp.json"), "{}");

    expect(resolveResumeCarrier("cp.json", { locals: { x: 1 } }, false, dir)).toEqual({
      checkpointFile: path.join(dir, "cp.json"),
      overridesJson: JSON.stringify({ locals: { x: 1 } }),
      force: false,
    });
  });

  it("carries the force choice", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agency-resume-carrier-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "cp.json"), "{}");

    expect(resolveResumeCarrier("cp.json", {}, true, dir).force).toBe(true);
  });

  it("rejects missing files and directories", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agency-resume-carrier-"));
    dirs.push(dir);
    expect(() => resolveResumeCarrier("missing.json", {}, false, dir)).toThrow("does not exist");
    expect(() => resolveResumeCarrier(".", {}, false, dir)).toThrow("is not a file");
  });

  it("refuses checkpoint symlinks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agency-resume-carrier-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "target.json"), "{}");
    symlinkSync("target.json", path.join(dir, "checkpoint.json"));

    expect(() => resolveResumeCarrier("checkpoint.json", {}, false, dir)).toThrow(
      "must not be a symlink",
    );
  });
});
