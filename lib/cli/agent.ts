import { compile } from "./commands.js";
import { spawn } from "child_process";
import * as path from "path";

export function agent(): void {
  // Resolve the bundled agent directory relative to this file in dist/
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  const agentDir = path.resolve(currentDir, "../agents/agency-agent");
  const agencyFile = path.join(agentDir, "agent.agency");
  const runFile = path.join(agentDir, "run.js");

  // Compile the agent's .agency file
  compile({}, agencyFile);

  // Run the wrapper
  console.log("---");
  const nodeProcess = spawn("node", [runFile], {
    stdio: "inherit",
    shell: false,
  });

  nodeProcess.on("error", (error) => {
    console.error(`Failed to run agent:`, error);
    process.exit(1);
  });

  nodeProcess.on("exit", (code) => {
    if (code !== 0) {
      process.exit(code || 1);
    }
  });
}
