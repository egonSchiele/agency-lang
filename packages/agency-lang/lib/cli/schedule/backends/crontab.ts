import { execSync } from "child_process";
import * as fs from "fs";
import type { ScheduleEntry } from "../registry.js";
import type { ScheduleBackend } from "./index.js";
import { writeRunScript } from "./writeRunScript.js";

function readCrontab(): string {
  try {
    return execSync("crontab -l", {
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
  } catch {
    return "";
  }
}

function writeCrontab(content: string): void {
  execSync("crontab -", { input: content });
}

function filterLines(crontab: string, name: string): string[] {
  return crontab
    .split("\n")
    .filter((line) => !line.includes(`# agency:${name}`));
}

export class CrontabBackend implements ScheduleBackend {
  install(entry: ScheduleEntry): void {
    const runScriptPath = writeRunScript(entry);

    if (!fs.existsSync(entry.logDir)) {
      fs.mkdirSync(entry.logDir, { recursive: true });
    }

    const lines = filterLines(readCrontab(), entry.name);
    lines.push(
      `${entry.cron} /bin/bash "${runScriptPath}" # agency:${entry.name}`,
    );
    const content =
      lines.filter((l) => l.trim() !== "").join("\n") + "\n";
    writeCrontab(content);
  }

  uninstall(name: string): void {
    const existing = readCrontab();
    if (!existing) return;
    const lines = filterLines(existing, name);
    const content =
      lines.filter((l) => l.trim() !== "").join("\n") + "\n";
    writeCrontab(content);
  }
}
