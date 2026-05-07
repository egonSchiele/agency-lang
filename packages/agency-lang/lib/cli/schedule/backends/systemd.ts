import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ScheduleEntry } from "../registry.js";
import type { ScheduleBackend } from "./index.js";
import { writeRunScript } from "./writeRunScript.js";
import { cronToOnCalendar } from "../cron.js";
import renderService from "@/templates/cli/schedule/service.js";
import renderTimer from "@/templates/cli/schedule/timer.js";

const UNIT_DIR = path.join(os.homedir(), ".config", "systemd", "user");

function unitName(name: string): string {
  return `agency-schedule-${name}`;
}

export class SystemdBackend implements ScheduleBackend {
  install(entry: ScheduleEntry): void {
    const runScriptPath = writeRunScript(entry);
    const unit = unitName(entry.name);

    const service = renderService({
      name: entry.name,
      agentDir: path.dirname(entry.agentFile),
      runScriptPath,
    });
    const timer = renderTimer({
      name: entry.name,
      onCalendar: cronToOnCalendar(entry.cron),
    });

    fs.mkdirSync(UNIT_DIR, { recursive: true });

    fs.writeFileSync(path.join(UNIT_DIR, `${unit}.service`), service);
    fs.writeFileSync(path.join(UNIT_DIR, `${unit}.timer`), timer);
    execSync("systemctl --user daemon-reload");
    execSync(`systemctl --user enable --now ${unit}.timer`);
  }

  uninstall(name: string): void {
    const unit = unitName(name);
    try {
      execSync(`systemctl --user disable --now ${unit}.timer`);
    } catch {}
    const servicePath = path.join(UNIT_DIR, `${unit}.service`);
    const timerPath = path.join(UNIT_DIR, `${unit}.timer`);
    if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
    if (fs.existsSync(timerPath)) fs.unlinkSync(timerPath);
    try {
      execSync("systemctl --user daemon-reload");
    } catch {}
  }
}
