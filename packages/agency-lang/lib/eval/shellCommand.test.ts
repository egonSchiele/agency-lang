import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OUTPUT_TAIL_CHARS,
  outputTail,
  resetShellInterruptForTests,
  runShell,
} from "./shellCommand.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runShell", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "shell-command-"));
    resetShellInterruptForTests();
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    resetShellInterruptForTests();
  });

  it("returns the exit status and both streams", async () => {
    const result = await runShell("echo out; echo err >&2; exit 3", {
      cwd,
      env: process.env,
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      status: 3,
      output: "out\nerr\n",
      timedOut: false,
      interrupted: false,
    });
  });

  it("passes the environment it is given, PATH included", async () => {
    const result = await runShell('echo "$PATH|$EXTRA"', {
      cwd,
      env: { ...process.env, EXTRA: "x" },
      timeoutMs: 5000,
    });
    expect(result.output.trim()).toBe(`${process.env.PATH}|x`);
  });

  it(
    "kills every process the command started when it runs out of time",
    { timeout: 10_000 },
    async () => {
      const result = await runShell("(sleep 2; touch late) & sleep 5", {
        cwd,
        env: process.env,
        timeoutMs: 500,
      });
      expect(result.timedOut).toBe(true);
      await wait(2500);
      expect(fs.existsSync(path.join(cwd, "late"))).toBe(false);
    },
  );

  it(
    "stops everything the command started when the process is interrupted",
    { timeout: 10_000 },
    async () => {
      const running = runShell("(sleep 2; touch late) & sleep 5", {
        cwd,
        env: process.env,
        timeoutMs: 8000,
      });
      await wait(300);
      process.emit("SIGINT");
      const result = await running;
      expect(result.interrupted).toBe(true);
      await wait(2500);
      expect(fs.existsSync(path.join(cwd, "late"))).toBe(false);
    },
  );

  it("does not start a command once the process has been interrupted", async () => {
    const first = runShell("sleep 5", { cwd, env: process.env, timeoutMs: 8000 });
    await wait(200);
    process.emit("SIGINT");
    await first;
    const second = await runShell("touch started", { cwd, env: process.env, timeoutMs: 5000 });
    expect(second).toEqual({
      status: null,
      output: "interrupted",
      timedOut: false,
      interrupted: true,
    });
    expect(fs.existsSync(path.join(cwd, "started"))).toBe(false);
  });
});

describe("outputTail", () => {
  it("keeps the end of long output", () => {
    const text = `${"progress line\n".repeat(500)}error: the real problem`;
    expect(outputTail(text).endsWith("error: the real problem")).toBe(true);
    expect(outputTail(text).startsWith("…")).toBe(true);
    expect(outputTail(text).length).toBe(OUTPUT_TAIL_CHARS + 1);
  });
  it("leaves short output alone", () => {
    expect(outputTail("short")).toBe("short");
  });
});
