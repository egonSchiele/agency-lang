import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { FakeSandbox } from "./fakeSandbox.js";
import { mustExec, quote, shellLine } from "./shell.js";
import { SandboxCommandError } from "./types.js";

function bash(line: string): string {
  try {
    return execFileSync("bash", ["-c", line], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch (error) {
    return String((error as { stdout?: Buffer }).stdout ?? "");
  }
}

describe("quote", () => {
  it("quotes a single quote", () => {
    expect(quote("it's")).toBe(`'it'\\''s'`);
  });
  it("leaves a plain word unquoted", () => {
    expect(quote("/repo/a-b_c.txt")).toBe("/repo/a-b_c.txt");
  });
  it("quotes the empty string", () => {
    expect(quote("")).toBe("''");
  });
});

describe("shellLine", () => {
  it("is the command alone with no options", () => {
    expect(shellLine("ls")).toBe("ls");
  });
  it("puts cwd and env inside the user's shell", () => {
    expect(shellLine("make", { user: "bench", cwd: "/repo", env: { CI: "true" } })).toBe(
      `su bench -s /bin/bash -c ${quote(`cd /repo && export CI=true && ( make )`)}`,
    );
  });
  it("quotes env values and the cwd", () => {
    expect(shellLine("x", { cwd: "/a b", env: { K: "v w" } })).toBe(
      `cd '/a b' && export K='v w' && ( x )`,
    );
  });
  it("refuses an env name that is not an identifier", () => {
    expect(() => shellLine("x", { env: { "A;B": "1" } })).toThrow("env name");
  });
  it("keeps both halves of a compound command in the cwd", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shell-")));
    expect(bash(shellLine("pwd; pwd", { cwd: dir })).trim().split("\n")).toEqual([dir, dir]);
  });
  it("runs neither half when the cd fails", () => {
    expect(bash(shellLine("false || echo ran", { cwd: "/no/such/dir" }))).not.toContain("ran");
  });
});

describe("mustExec", () => {
  it("returns the output on exit 0", async () => {
    const sandbox = new FakeSandbox(() => ({ output: "hi" }));
    expect(await mustExec(sandbox, "greet", "echo hi")).toBe("hi");
  });
  it("throws SandboxCommandError with the last 3000 characters", async () => {
    const sandbox = new FakeSandbox(() => ({ exitCode: 2, output: "x".repeat(5000) }));
    const error = await mustExec(sandbox, "build", "make").catch((e) => e);
    expect(error).toBeInstanceOf(SandboxCommandError);
    expect(error.exitCode).toBe(2);
    expect(error.outputTail).toHaveLength(3000);
    expect(error.message).toContain("build failed (exit 2)");
  });
  it("sends the finished line", async () => {
    const sandbox = new FakeSandbox();
    await mustExec(sandbox, "list", "ls", { cwd: "/repo" });
    expect(sandbox.commands).toEqual(["cd /repo && ( ls )"]);
  });
  it("passes the timeout on", async () => {
    const sandbox = new FakeSandbox();
    await mustExec(sandbox, "list", "ls", { timeoutSec: 42 });
    expect(sandbox.timeouts).toEqual([42]);
  });
});
