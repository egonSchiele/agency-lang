import { AgencyConfig } from "@/config.js";
import { compile, compiledOutputEnv } from "./commands.js";
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

  // The compiled agent.js already includes a top-level invocation of `main()`,
  // so we run it directly. (Older code expected a hand-written run.js wrapper
  // that no longer exists.)
  const runFile = compile(config, agencyFile);
  if (runFile === null) {
    console.error(`Failed to compile agent ${agentName}.`);
    process.exit(1);
  }

  console.log("---");
  const nodeProcess = spawn(process.execPath, [runFile, ...args], {
    stdio: "inherit",
    shell: false,
    env: compiledOutputEnv(process.env),
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
