import { spawnSync, SpawnSyncOptions } from "child_process";
import process from "process";

export function _bash(
  command: string,
  cwd?: string,
  timeout?: number,
  stdin?: string,
  env?: object,
  maxBuffer?: number,
): { stdout: string; stderr: string; exitCode: number } {
  const options: SpawnSyncOptions = {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  };

  if (cwd !== undefined) {
    options.cwd = cwd;
  }
  if (timeout !== undefined) {
    options.timeout = timeout * 1000;
  }
  if (stdin !== undefined) {
    options.input = stdin;
  }
  if (env !== undefined) {
    options.env = { ...process.env, ...(env as Record<string, string>) };
  }
  if (maxBuffer !== undefined) {
    options.maxBuffer = maxBuffer;
  }

  const result = spawnSync("sh", ["-c", command], options);
  return {
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
    exitCode: result.status ?? 1,
  };
}
