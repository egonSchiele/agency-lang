import { spawn } from "node:child_process";
import type { Child } from "./localServe.js";

/** How `agency local serve` starts a model process: the options every
 *  process gets, and the two ways its output can go. */

/** Where a model process's output goes: to this terminal, or to a pipe
 *  the caller reads. */
export type ChildOutput = "inherit" | "pipe";

/** The options every model process is started with. A piped process is
 *  told not to buffer, because Python writes in blocks when its output is
 *  not a terminal, and its lines would arrive late. */
export function spawnOptions(output: ChildOutput): {
  stdio: ["pipe", ChildOutput, ChildOutput];
  env: Record<string, string | undefined>;
} {
  const piped = output === "pipe" ? { PYTHONUNBUFFERED: "1" } : {};
  return {
    // Standard input is a pipe this process never writes to. It closes
    // when this process exits, however it exits, and the server script
    // exits with it. See exit_when_parent_goes in localServerCommon.py.
    stdio: ["pipe", output, output],
    env: {
      ...process.env,
      HF_HUB_OFFLINE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
      AGENCY_EXIT_WITH_PARENT: "1",
      ...piped,
    },
  };
}

export function realSpawn(python: string, args: string[]): Child {
  return spawn(python, args, spawnOptions("inherit"));
}

/** Hands each line of a stream to `log`. A line ends at a newline or a
 *  carriage return, since progress bars redraw with the second. */
function logLines(stream: NodeJS.ReadableStream, log: (line: string) => void): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (pending + chunk).split(/[\r\n]+/);
    pending = lines.pop() ?? "";
    lines.filter((line) => line !== "").forEach(log);
  });
  stream.on("end", () => {
    if (pending !== "") {
      log(pending);
    }
  });
}

/** Starts a model process whose output goes to `log`, a line at a time.
 *  The pipes are always read, whatever `log` does with the lines: a
 *  process whose pipe fills up stops. */
export function pipedSpawn(log: (line: string) => void): (python: string, args: string[]) => Child {
  return (python, args) => {
    const child = spawn(python, args, spawnOptions("pipe"));
    logLines(child.stdout!, log);
    logLines(child.stderr!, log);
    return child;
  };
}
