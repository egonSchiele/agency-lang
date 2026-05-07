import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ScheduleEntry } from "../registry.js";
import type { ScheduleBackend } from "./index.js";
import { writeRunScript } from "./writeRunScript.js";
import renderPlist from "@/templates/cli/schedule/plist.js";

const PLIST_DIR = path.join(os.homedir(), "Library", "LaunchAgents");

function plistPath(name: string): string {
  return path.join(PLIST_DIR, `com.agency.schedule.${name}.plist`);
}

function buildIntervals(cron: string): string {
  const [minute, hour, dom, month, dow] = cron.split(/\s+/);
  return [
    minute !== "*" &&
      `      <key>Minute</key>\n      <integer>${minute}</integer>`,
    hour !== "*" &&
      `      <key>Hour</key>\n      <integer>${hour}</integer>`,
    dom !== "*" &&
      `      <key>Day</key>\n      <integer>${dom}</integer>`,
    month !== "*" &&
      `      <key>Month</key>\n      <integer>${month}</integer>`,
    dow !== "*" &&
      `      <key>Weekday</key>\n      <integer>${dow}</integer>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class LaunchdBackend implements ScheduleBackend {
  install(entry: ScheduleEntry): void {
    const runScriptPath = writeRunScript(entry);
    const plist = renderPlist({
      name: entry.name,
      runScriptPath,
      agentDir: path.dirname(entry.agentFile),
      intervals: buildIntervals(entry.cron),
      logDir: entry.logDir,
    });
    const dest = plistPath(entry.name);

    fs.mkdirSync(PLIST_DIR, { recursive: true });

    fs.writeFileSync(dest, plist);
    execSync(`launchctl load "${dest}"`);
  }

  uninstall(name: string): void {
    const dest = plistPath(name);
    if (fs.existsSync(dest)) {
      try {
        execSync(`launchctl unload "${dest}"`);
      } catch {}
      fs.unlinkSync(dest);
    }
  }
}
