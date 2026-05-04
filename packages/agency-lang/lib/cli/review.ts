import { AgencyConfig } from "@/config.js";
import { compile } from "./commands.js";
import { spawn } from "child_process";
import * as path from "path";

export function review(config: AgencyConfig, targetFile: string): void {
  // Resolve the bundled review agent directory relative to this file in dist/
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const agentDir = path.resolve(currentDir, "../agents/review");
  const agencyFile = path.join(agentDir, "agent.agency");
  const runFile = path.join(agentDir, "run.js");

  // Resolve the target file to an absolute path
  const absoluteTarget = path.resolve(targetFile);

  // Compile the review agent's .agency file
  compile(config, agencyFile);

  // Run the wrapper, passing the target file as an argument
  console.log("---");
  const nodeProcess = spawn("node", [runFile, absoluteTarget], {
    stdio: "inherit",
    shell: false,
  });

  nodeProcess.on("error", (error) => {
    console.error(`Failed to run review agent:`, error);
    process.exit(1);
  });

  nodeProcess.on("exit", (code) => {
    if (code !== 0) {
      process.exit(code || 1);
    }
  });
}
