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
// This file checks that the built CLI runs the command and hands it the
// name: with the name dropped, it would print the full list instead.
describe.skipIf(!existsSync(CLI))("agency effects", () => {
  it("passes the name to the command", async () => {
    const { code, stdout } = await effects("FileRead");
    expect(code).toBe(0);
    expect(stdout).toContain("std::read");
    expect(stdout).not.toContain("Built-in policies:");
  });
});
