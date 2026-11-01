import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { definedVariables, nodeSubprocess } from "./nodeSubprocess.js";
import type { RunOptions } from "../host.js";
import { safeDeleteDirectoryWithin } from "../../utils.js";

const shell = (script: string, options: RunOptions = {}) =>
  nodeSubprocess.run({ kind: "shell", script }, options);

async function withTempDir(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-shell-"));
  try {
    await work(dir);
  } finally {
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  }
}

const parentEnv = () => definedVariables(process.env);

describe("the shell a script runs under", () => {
  it("runs scripts with bash: &> redirects both streams into the file", () =>
    withTempDir(async (dir) => {
      const result = await shell("echo hi &> out.txt", { cwd: dir });
      expect(result.stdout).toBe("");
      expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("hi\n");
    }));

  it("runs scripts with bash: echo -n drops the newline and echo keeps a backslash", async () => {
    expect((await shell("echo -n hi")).stdout).toBe("hi");
    expect((await shell("echo 'a\\tb'")).stdout).toBe("a\\tb\n");
  });

  it("rejects with a message naming bash when the search path has none", () =>
    withTempDir(async (empty) => {
      await expect(shell("echo hi", { env: { PATH: empty } })).rejects.toThrow(
        "bash was not found on the PATH",
      );
    }));

  it("does not source BASH_ENV before the script", () =>
    withTempDir(async (dir) => {
      fs.writeFileSync(path.join(dir, "env.sh"), "touch sourced\n");
      await shell("echo hi", {
        cwd: dir,
        env: { ...parentEnv(), BASH_ENV: path.join(dir, "env.sh") },
      });
      expect(fs.existsSync(path.join(dir, "sourced"))).toBe(false);
    }));

  it("does not import an exported function that shadows a program", async () => {
    const fake = "() { echo FAKE-GIT; }";
    const env = { ...parentEnv(), "BASH_FUNC_git%%": fake, "BASH_FUNC_git()": fake };
    const result = await shell("git --version", { env });
    expect(result.stdout).toMatch(/^git version/);
  });

  it("ignores POSIXLY_CORRECT: echo -n still drops the newline", async () => {
    const env = { ...parentEnv(), POSIXLY_CORRECT: "1" };
    expect((await shell("echo -n hi", { env })).stdout).toBe("hi");
  });
});
