import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).error === undefined;

/** A Python program that starts the watcher and then sleeps, as a server
 *  that is loading its model does. */
const PROGRAM = [
  "import sys, time",
  `sys.path.insert(0, ${JSON.stringify(cliDir)})`,
  "from localServerCommon import exit_when_parent_goes",
  "exit_when_parent_goes()",
  "time.sleep(30)",
].join("\n");

type Outcome = { exited: boolean; code: number | null };

/** Starts the program with its standard input a pipe, closes the pipe,
 *  and reports whether the program exited within a second. */
function runWithClosedStdin(env: Record<string, string>): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", PROGRAM], {
      stdio: ["pipe", "ignore", "inherit"],
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exited: false, code: null });
    }, 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code });
    });
    child.stdin!.end();
  });
}

describe.skipIf(!hasPython3)("exit_when_parent_goes", () => {
  it("exits when standard input closes, once the parent asked for it", async () => {
    const outcome = await runWithClosedStdin({ AGENCY_EXIT_WITH_PARENT: "1" });
    expect(outcome).toEqual({ exited: true, code: 0 });
  });

  it("does nothing without the environment variable, so a server started by hand keeps running", async () => {
    const outcome = await runWithClosedStdin({ AGENCY_EXIT_WITH_PARENT: "" });
    expect(outcome.exited).toBe(false);
  });
});

describe("the server scripts", () => {
  it("each start the watcher", () => {
    const scripts = [
      "mlxChatServer.py",
      "mlxEmbedServer.py",
      "mlxSpeechServer.py",
      "diffusersImageServer.py",
      "visionServer.py",
      "mlxVlmServer.py",
    ];
    for (const script of scripts) {
      const source = fs.readFileSync(path.join(cliDir, script), "utf8");
      expect(source, script).toContain("exit_when_parent_goes()");
    }
  });
});
