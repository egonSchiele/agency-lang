import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { definedVariables, nodeSubprocess, shellEnvironment } from "./nodeSubprocess.js";
import { TERM_GRACE_MS, killTrackedChildren } from "./processGroups.js";
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

describe("shellEnvironment", () => {
  it("removes the variables that point git elsewhere or make it run a program", () => {
    const env = {
      PATH: "/usr/bin",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/index",
      GIT_EXTERNAL_DIFF: "/tmp/run-me",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_GLOBAL: "/tmp/config",
      "BASH_FUNC_git%%": "() { echo FAKE; }",
      BASH_ENV: "/tmp/env.sh",
    };
    expect(shellEnvironment(env)).toEqual({ PATH: "/usr/bin" });
  });

  it("removes the variables that send gh to another host or repository, and keeps its tokens", () => {
    const env = {
      GH_HOST: "ghe.example.com",
      GH_REPO: "other/private",
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
    };
    expect(shellEnvironment(env)).toEqual({ GH_TOKEN: "a", GITHUB_TOKEN: "b" });
  });

  it("keeps the variables that name git's SSH program, and unrelated GIT_ names", () => {
    const env = {
      GIT_SSH_COMMAND: "ssh -i ~/.ssh/work",
      GIT_SSH: "/usr/bin/ssh",
      GIT_PROXY_COMMAND: "proxy",
      GIT_AUTHOR_NAME: "Dana",
    };
    expect(shellEnvironment(env)).toEqual(env);
  });
});

describe("the shell a script runs under", () => {
  it("does not hand GIT_DIR to the script", async () => {
    const env = { ...parentEnv(), GIT_DIR: "/elsewhere/.git", GIT_SSH_COMMAND: "ssh -v" };
    const result = await shell('echo "${GIT_DIR:-unset} ${GIT_SSH_COMMAND:-unset}"', { env });
    expect(result.stdout).toBe("unset ssh -v\n");
  });

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

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: no such process.
    return false;
  }
};

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40 && isAlive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

async function timed<T>(work: Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await work;
  return { result, ms: Date.now() - start };
}

describe.skipIf(process.platform === "win32")("stopping a command", () => {
  it("a time limit stops what the script started, and keeps the output so far", async () => {
    const { result, ms } = await timed(shell("sleep 30 & echo $!; wait", { timeoutMs: 200 }));
    expect(result.timedOut).toBe(true);
    expect(ms).toBeLessThan(1500);
    expect(await waitUntilGone(Number(result.stdout.trim()))).toBe(true);
  });

  it("an abort returns while a later command of the script is still to run", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const { result, ms } = await timed(shell("sleep 30; echo done", { signal: controller.signal }));
    expect(result.aborted).toBe(true);
    expect(result.stdout).toBe("");
    expect(ms).toBeLessThan(1500);
  });

  it("a script that ignores SIGTERM is killed after the grace period", async () => {
    const { result, ms } = await timed(
      shell("trap '' TERM; echo ready; sleep 30", { timeoutMs: 200 }),
    );
    expect(result.stdout).toBe("ready\n");
    expect(ms).toBeGreaterThan(TERM_GRACE_MS);
    expect(ms).toBeLessThan(TERM_GRACE_MS + 2000);
  });

  it("returns when a process that left the group still holds the output pipe", async () => {
    const escape = `perl -MPOSIX -e '$| = 1; setsid(); print "$$\\n"; sleep 20' & wait`;
    const { result, ms } = await timed(shell(escape, { timeoutMs: 300 }));
    const escaped = Number(result.stdout.trim());
    try {
      expect(result.timedOut).toBe(true);
      expect(ms).toBeLessThan(2000);
      // Still running: the group kill did not reach it, so only the pipe
      // rule can have ended the call.
      expect(isAlive(escaped)).toBe(true);
    } finally {
      process.kill(escaped, "SIGKILL");
    }
  });

  it("killing the tracked children, as the exit hook does, stops a running command", () =>
    withTempDir(async (dir) => {
      const pidFile = path.join(dir, "pid");
      const running = await nodeSubprocess.start({
        kind: "shell",
        script: `sleep 30 & echo $! > ${pidFile}; wait`,
      });
      while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8").trim() === "") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      killTrackedChildren();
      await running.wait();
      expect(await waitUntilGone(Number(fs.readFileSync(pidFile, "utf8").trim()))).toBe(true);
    }));

  it("leaves an exit signal to a handler the program registered with once", async () => {
    // A signal this process sends itself is recorded and not delivered, so
    // a failure of this test does not end the test run.
    const sentToSelf: string[] = [];
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === process.pid) {
        sentToSelf.push(String(signal));
        return true;
      }
      return realKill(pid, signal);
    });
    let handled = false;
    const theirs = () => {
      handled = true;
    };
    process.once("SIGHUP", theirs);
    const running = await nodeSubprocess.start({ kind: "shell", script: "sleep 30" });
    try {
      process.emit("SIGHUP", "SIGHUP");
      expect(handled).toBe(true);
      expect(sentToSelf).toEqual([]);
    } finally {
      process.removeListener("SIGHUP", theirs);
      running.kill("SIGKILL");
      await running.wait();
      spy.mockRestore();
    }
  });
});
