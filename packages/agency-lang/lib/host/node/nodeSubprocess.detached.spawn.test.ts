// End to end: the subprocess functions a job needs to start a process that
// outlives this one, find it again, and stop it. Every process a test
// starts is stopped before the test ends.
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { safeDeleteDirectoryWithin } from "../../utils.js";
import { nodeSubprocess } from "./nodeSubprocess.js";

const START_TIME_SLACK_MS = 5_000;
const WAIT_MS = 5_000;
const POLL_MS = 50;
/** A pid no system hands out. */
const NEVER_A_PID = 2 ** 30;

const started: number[] = [];

afterEach(async () => {
  for (const pid of started.splice(0)) {
    await nodeSubprocess.stopGroup(pid);
  }
});

async function until(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return check();
}

describe("startDetached", () => {
  it("starts a process that this one can find and stop", async () => {
    const { pid } = await nodeSubprocess.startDetached({
      kind: "program",
      program: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
    });
    started.push(pid);
    expect(typeof pid).toBe("number");
    expect(nodeSubprocess.processState(pid)).toBe("alive");
    const startedAt = nodeSubprocess.processStartedAt(pid);
    expect(startedAt).not.toBeNull();
    expect(Math.abs(startedAt! - Date.now())).toBeLessThan(START_TIME_SLACK_MS);

    await nodeSubprocess.stopGroup(pid);
    expect(await until(() => nodeSubprocess.processState(pid) === "gone")).toBe(true);
    expect(nodeSubprocess.processStartedAt(pid)).toBeNull();
  });
});

describe("startDetached with an output file", () => {
  it("appends what the process prints to the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-detached-"));
    try {
      const file = path.join(dir, "out.log");
      fs.writeFileSync(file, "before\n");
      const { pid } = await nodeSubprocess.startDetached(
        { kind: "program", program: process.execPath, args: ["-e", "console.error('printed')"] },
        { outputFile: file },
      );
      started.push(pid);
      expect(await until(() => fs.readFileSync(file, "utf8").includes("printed"))).toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe("before\nprinted\n");
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), dir);
    }
  });

  it("refuses an output file that is a symbolic link", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-detached-"));
    try {
      const link = path.join(dir, "out.log");
      fs.symlinkSync(path.join(dir, "elsewhere.log"), link);
      await expect(
        nodeSubprocess.startDetached(
          { kind: "program", program: process.execPath, args: ["-e", ""] },
          { outputFile: link },
        ),
      ).rejects.toThrow();
      expect(fs.existsSync(path.join(dir, "elsewhere.log"))).toBe(false);
    } finally {
      safeDeleteDirectoryWithin(os.tmpdir(), dir);
    }
  });
});

describe("processState", () => {
  it("reads a pid that never existed as gone", () => {
    expect(nodeSubprocess.processState(NEVER_A_PID)).toBe("gone");
    expect(nodeSubprocess.processStartedAt(NEVER_A_PID)).toBeNull();
  });
});

describe("stopGroup", () => {
  it("stops a command and the child it started", async () => {
    const running = await nodeSubprocess.start({
      kind: "shell",
      script: "sleep 30 & echo $!; wait",
    });
    expect(running.pid).not.toBeNull();
    const pid = running.pid!;
    started.push(pid);
    expect(await until(() => running.output().stdout.trim() !== "")).toBe(true);
    const childPid = Number(running.output().stdout.trim());
    expect(nodeSubprocess.processState(childPid)).toBe("alive");

    await nodeSubprocess.stopGroup(pid);
    expect(await until(() => nodeSubprocess.processState(pid) === "gone")).toBe(true);
    expect(await until(() => nodeSubprocess.processState(childPid) === "gone")).toBe(true);
  });
});
