import * as fs from "fs";
import * as path from "path";
import type { ScheduleEntry } from "../registry.js";
import renderRunScript from "@/templates/cli/schedule/runScript.js";

export function writeRunScript(entry: ScheduleEntry): string {
  const scriptDir = path.dirname(entry.logDir);
  const scriptPath = path.join(scriptDir, "run.sh");

  const content = renderRunScript({
    agentDir: path.dirname(entry.agentFile),
    hasEnvFile: !!entry.envFile,
    envFile: entry.envFile,
    logDir: entry.logDir,
    command: entry.command,
    agentFile: entry.agentFile,
  });

  if (!fs.existsSync(scriptDir)) fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}
