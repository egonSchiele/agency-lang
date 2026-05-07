import { execFileSync } from "child_process";
import type { ScheduleEntry, BackendType } from "../registry.js";
import { LaunchdBackend } from "./launchd.js";
import { SystemdBackend } from "./systemd.js";
import { CrontabBackend } from "./crontab.js";

export type { BackendType } from "../registry.js";

export type ScheduleBackend = {
  install(entry: ScheduleEntry): void;
  uninstall(name: string): void;
};

export function detectBackend(): BackendType {
  if (process.platform === "darwin") return "launchd";
  try {
    // execFileSync throws if `which` exits non-zero (systemctl not found) or ENOENT
    execFileSync("which", ["systemctl"], { stdio: "pipe" });
    return "systemd";
  } catch {
    return "crontab";
  }
}

export function getBackend(type: BackendType): ScheduleBackend {
  switch (type) {
    case "launchd":
      return new LaunchdBackend();
    case "systemd":
      return new SystemdBackend();
    case "crontab":
      return new CrontabBackend();
  }
}

export { LaunchdBackend } from "./launchd.js";
export { SystemdBackend } from "./systemd.js";
export { CrontabBackend } from "./crontab.js";
