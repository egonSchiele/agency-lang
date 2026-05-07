import { execFileSync } from "child_process";
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

// Declarative mapping: cron field position → launchd StartCalendarInterval key
const CRON_TO_LAUNCHD = [
  { index: 0, key: "Minute", bounds: [0, 59] as [number, number] },
  { index: 1, key: "Hour", bounds: [0, 23] as [number, number] },
  { index: 2, key: "Day", bounds: [1, 31] as [number, number] },
  { index: 3, key: "Month", bounds: [1, 12] as [number, number] },
  { index: 4, key: "Weekday", bounds: [0, 6] as [number, number] },
] as const;

// Expand a cron field like "1-5" or "0,30" into an array of integers.
// Returns [] for wildcards ("*"), meaning "don't constrain this field".
function expandField(field: string, fieldIndex: number): number[] {
  if (field === "*") return [];
  const [min, max] = CRON_TO_LAUNCHD[fieldIndex].bounds;
  return field.split(",").flatMap((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (range === "*") {
      // */N — expand wildcard with step over the full domain
      return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);
    }
    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      return Array.from({ length: Math.floor((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
    }
    return [parseInt(range, 10)];
  });
}

// launchd requires one dict per unique combination of constrained fields.
// E.g. "weekdays at 9am" = 5 dicts (one per weekday), each with Hour=9, Minute=0.
export function buildIntervals(cron: string): string {
  const cronFields = cron.split(/\s+/);
  const expanded = CRON_TO_LAUNCHD
    .map(({ index, key }, i) => ({ key, values: expandField(cronFields[index], i) }))
    .filter(({ values }) => values.length > 0);

  // Cartesian product of all constrained fields
  const combos = expanded.reduce<Record<string, number>[]>(
    (acc, { key, values }) => acc.flatMap((combo) => values.map((v) => ({ ...combo, [key]: v }))),
    [{}],
  );

  const formatDict = (dict: Record<string, number>) =>
    Object.entries(dict)
      .map(([k, v]) => `      <key>${k}</key>\n      <integer>${v}</integer>`)
      .join("\n");

  if (combos.length === 1) {
    return `  <dict>\n${formatDict(combos[0])}\n  </dict>`;
  }
  const dicts = combos.map((c) => `    <dict>\n${formatDict(c)}\n    </dict>`).join("\n");
  return `  <array>\n${dicts}\n  </array>`;
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
    // Unload first if already loaded (launchctl load fails on already-loaded plists)
    if (fs.existsSync(dest)) {
      try { execFileSync("launchctl", ["unload", dest]); } catch {}
    }
    fs.writeFileSync(dest, plist);
    execFileSync("launchctl", ["load", dest]);
  }

  uninstall(name: string): void {
    const dest = plistPath(name);
    if (fs.existsSync(dest)) {
      try {
        execFileSync("launchctl", ["unload", dest]);
      } catch {}
      fs.unlinkSync(dest);
    }
  }
}
