import { AgencyConfig } from "@/config.js";
import { compile, compiledOutputNodeArgs } from "./commands.js";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const currentDir = path.dirname(new URL(import.meta.url).pathname);

export function runBundledAgent(
  config: AgencyConfig,
  agentName: string,
  args: string[] = [],
): void {
  const agentDir = path.resolve(currentDir, `../agents/${agentName}`);
  const agencyFile = path.join(agentDir, "agent.agency");
  const precompiledFile = path.join(agentDir, "agent.js");

  // Prefer the precompiled agent.js produced by `make agents` so users
  // don't pay the compile cost on every invocation. Falls back to a
  // fresh compile if the bundle hasn't been built yet.
  let runFile: string | null;
  if (fs.existsSync(precompiledFile)) {
    runFile = precompiledFile;
  } else {
    runFile = compile(config, agencyFile);
  }
  if (runFile === null) {
    console.error(`Failed to compile agent ${agentName}.`);
    process.exit(1);
  }

  const nodeProcess = spawn(
    process.execPath,
    [...compiledOutputNodeArgs(), runFile, ...args],
    {
      stdio: "inherit",
      shell: false,
    },
  );

  nodeProcess.on("error", (error) => {
    console.error(`Failed to run ${agentName}:`, error);
    process.exit(1);
  });

  nodeProcess.on("exit", (code) => {
    if (code !== 0) {
      console.error(`${agentName} exited with code ${code}.`);
      process.exit(code || 1);
    }
  });
}
