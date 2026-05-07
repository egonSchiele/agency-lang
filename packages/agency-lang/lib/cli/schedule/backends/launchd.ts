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

function expandField(field: string): number[] {
  const results: number[] = [];
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (range === "*") return []; // wildcard means "don't constrain this field"
    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      for (let i = lo; i <= hi; i += step) results.push(i);
    } else {
      results.push(parseInt(range, 10));
    }
  }
  return results;
}

function buildIntervals(cron: string): string {
  const [minute, hour, dom, month, dow] = cron.split(/\s+/);
  const minutes = expandField(minute);
  const hours = expandField(hour);
  const days = expandField(dom);
  const months = expandField(month);
  const weekdays = expandField(dow);

  // Generate all combinations that need separate dicts.
  // launchd requires one dict per unique combination of constrained fields.
  // For most presets, only weekday varies (e.g. weekdays = 5 dicts).
  const combos = buildCombos(minutes, hours, days, months, weekdays);

  if (combos.length === 1) {
    return `  <dict>\n${formatDict(combos[0])}\n  </dict>`;
  }

  const dicts = combos
    .map((c) => `    <dict>\n${formatDict(c)}\n    </dict>`)
    .join("\n");
  return `  <array>\n${dicts}\n  </array>`;
}

type IntervalDict = {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
};

function buildCombos(
  minutes: number[],
  hours: number[],
  days: number[],
  months: number[],
  weekdays: number[],
): IntervalDict[] {
  // Start with a single empty dict and expand for each constrained field
  let combos: IntervalDict[] = [{}];

  if (minutes.length > 0) combos = combos.flatMap((c) => minutes.map((v) => ({ ...c, Minute: v })));
  if (hours.length > 0) combos = combos.flatMap((c) => hours.map((v) => ({ ...c, Hour: v })));
  if (days.length > 0) combos = combos.flatMap((c) => days.map((v) => ({ ...c, Day: v })));
  if (months.length > 0) combos = combos.flatMap((c) => months.map((v) => ({ ...c, Month: v })));
  if (weekdays.length > 0) combos = combos.flatMap((c) => weekdays.map((v) => ({ ...c, Weekday: v })));

  return combos.length === 0 ? [{}] : combos;
}

function formatDict(dict: IntervalDict): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(dict)) {
    if (val !== undefined) {
      lines.push(`      <key>${key}</key>\n      <integer>${val}</integer>`);
    }
  }
  return lines.join("\n");
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
