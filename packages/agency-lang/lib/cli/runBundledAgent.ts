import { AgencyConfig } from "@/config.js";
import { compile, compiledOutputNodeArgs } from "./commands.js";
import { spawn as realSpawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { DEBUG_ENV_VARS } from "../runtime/configOverrides.js";

const currentDir = path.dirname(new URL(import.meta.url).pathname);

/**
 * Translate the forwarded agent args to trace/statelog env vars, using the SAME
 * token rules std::args uses (lib/stdlib/args.ts:492,501,512): stop at a
 * standalone `--`; accept `--flag=value`; treat the next token as a value only
 * if it is defined, not `--`, and does not start with `-`. Pure + exported.
 * The env var — not the flag — does the wiring (RuntimeContext is built before
 * the agent's main() parses flags), so the agent also DECLARES these flags for
 * --help; both sides sharing DEBUG_ENV_VARS keeps them in sync.
 */
export function agentDebugFlagsToEnv(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (afterDoubleDash) continue;
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!token.startsWith("--")) continue;

    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const attached = eq === -1 ? undefined : token.slice(eq + 1);
    const next = args[i + 1];
    const nextIsValue = next !== undefined && next !== "--" && !next.startsWith("-");

    if (name === "trace") {
      if (attached !== undefined) {
        env[DEBUG_ENV_VARS.traceFile] = attached;
      } else if (nextIsValue) {
        env[DEBUG_ENV_VARS.traceFile] = next;
        i++;
      } else {
        env[DEBUG_ENV_VARS.traceDir] = "."; // bare --trace: per-runId trace in cwd
      }
    } else if (name === "log-file") {
      if (attached !== undefined) {
        env[DEBUG_ENV_VARS.logFile] = attached;
      } else if (nextIsValue) {
        env[DEBUG_ENV_VARS.logFile] = next;
        i++;
      }
      // bare --log-file: no optional value → ignore (agent's parser would error)
    }
  }
  return env;
}

export function runBundledAgent(
  config: AgencyConfig,
  agentName: string,
  args: string[] = [],
  deps: { spawn?: typeof realSpawn } = {},
): void {
  const spawn = deps.spawn ?? realSpawn;
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
      env: { ...process.env, ...agentDebugFlagsToEnv(args) },
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
