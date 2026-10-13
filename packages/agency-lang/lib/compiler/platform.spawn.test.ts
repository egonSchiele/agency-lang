import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const CLI = path.resolve("dist/scripts/agency.js");

async function agency(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// The program is written inside the package, not in the system temp
// directory, so the compiled file can resolve the runtime.
const dir = path.resolve("tests", "zz-platform-spawn");
const file = path.join(dir, "reads.agency");

describe.skipIf(!fs.existsSync(CLI))("--platform on compile and typecheck", () => {
  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'node main() {\n  const text = read("notes.txt")\n  print(text)\n}\n');
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("compile --platform browser refuses a program that reads a file", async () => {
    const { code, stderr } = await agency("compile", "--platform", "browser", file);
    expect(code).toBe(1);
    expect(stderr).toContain("AG3029");
    expect(stderr).toContain("The browser platform does not have it.");
    expect(stderr).toContain(
      "main calls read from std::index (reads.agency:2), which raises std::read",
    );
  });

  it("typecheck --platform browser reports the same error", async () => {
    const { code, stderr, stdout } = await agency("typecheck", "--platform", "browser", file);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain("AG3029");
  });

  it("compile for Node, the default, still compiles it", async () => {
    const { code } = await agency("compile", file);
    expect(code).toBe(0);
  });

  it("refuses a platform it does not know", async () => {
    const { code, stderr } = await agency("compile", "--platform", "ios", file);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Expected node or browser");
  });
});
