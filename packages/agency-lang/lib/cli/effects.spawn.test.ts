import { describe, it, expect } from "vitest";
import { execFile } from "child_process";
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

describe("agency effects", () => {
  it("lists sets and built-in policies", async () => {
    const { code, stdout } = await effects();
    expect(code).toBe(0);
    expect(stdout).toContain("FileRead");
    expect(stdout).toContain("Read-only filesystem access");
    expect(stdout).toContain("Built-in policies:");
    expect(stdout).toContain("with-writes");
  });

  it("describes one set with its members", async () => {
    const { code, stdout } = await effects("FileRead");
    expect(code).toBe(0);
    expect(stdout).toContain("std::read");
    expect(stdout).toContain("std::grep");
  });

  it("shows a nested set's composition", async () => {
    const { stdout } = await effects("FileSystem");
    expect(stdout).toContain("FileSystem = FileRead + FileWrite");
  });

  it("reverse-looks-up an effect name", async () => {
    const { code, stdout } = await effects("std::write");
    expect(code).toBe(0);
    expect(stdout).toContain("FileWrite");
    expect(stdout).toContain("FileSystem");
  });

  it("prints a built-in policy resolved against the cwd", async () => {
    const { code, stdout } = await effects("with-writes");
    expect(code).toBe(0);
    expect(stdout).toContain('"std::write"');
    expect(stdout).toContain('"action": "approve"');
  });

  it("errors on an unknown name with a near-miss hint", async () => {
    const { code, stderr } = await effects("FileReed");
    expect(code).toBe(1);
    expect(stderr).toContain("FileRead");
  });
});
