import { spawnSync } from "node:child_process";

/** Whether ffmpeg is on the PATH, for tests that encode real audio. */
export function hasFfmpeg(): boolean {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error === undefined;
}
