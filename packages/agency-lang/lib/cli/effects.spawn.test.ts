import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/scripts/agency.js");

async function effects(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, "effects", ...args]);
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// Which output each argument picks is tested in-process in effects.test.ts.
// This file only checks that the built CLI runs the command.
describe.skipIf(!existsSync(CLI))("agency effects", () => {
  it("lists sets and built-in policies", async () => {
    const { code, stdout } = await effects();
    expect(code).toBe(0);
    expect(stdout).toContain("FileRead");
    expect(stdout).toContain("Read-only filesystem access");
    expect(stdout).toContain("Built-in policies:");
    expect(stdout).toContain("with-writes");
  });
});
