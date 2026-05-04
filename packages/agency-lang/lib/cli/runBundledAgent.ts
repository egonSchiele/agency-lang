import { AgencyConfig } from "@/config.js";
import { compile } from "./commands.js";
import { spawn } from "child_process";
import * as path from "path";

const currentDir = path.dirname(new URL(import.meta.url).pathname);

export function runBundledAgent(
  config: AgencyConfig,
  agentName: string,
  args: string[] = [],
): void {
  const agentDir = path.resolve(currentDir, `../agents/${agentName}`);
  const agencyFile = path.join(agentDir, "agent.agency");
  const runFile = path.join(agentDir, "run.js");

  compile(config, agencyFile);

  console.log("---");
  const nodeProcess = spawn("node", [runFile, ...args], {
    stdio: "inherit",
    shell: false,
  });

  nodeProcess.on("error", (error) => {
    console.error(`Failed to run ${agentName}:`, error);
    process.exit(1);
  });

  nodeProcess.on("exit", (code) => {
    if (code !== 0) {
      process.exit(code || 1);
    }
  });
}
