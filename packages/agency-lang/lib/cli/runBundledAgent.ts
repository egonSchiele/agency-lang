import {
  AgencyConfig,
  applyCliFlags,
  CONFIG_OVERRIDES_ENV,
  serializeConfigOverrides,
  type CliFlags,
} from "@/config.js";
import { compile, compiledOutputNodeArgs } from "./commands.js";
import { spawn as realSpawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseArgs } from "node:util";

const currentDir = path.dirname(new URL(import.meta.url).pathname);

/**
 * Extract the debug flags every bundled agent understands (`--trace`,
 * `--log-file`) from its forwarded argv, as a config override. This is the ONE
 * place these flags are handled — every bundled agent gets them for free by
 * going through `runBundledAgent`; no agent writes flag code.
 *
 * Parsing is delegated to `node:util.parseArgs` (the standard library parser
 * `std::args` itself is built on), so `--flag=value`, the `--` terminator, and
 * last-wins-on-repeat all fall out correctly. `strict: false` ignores the
 * agent's own flags. A bare or empty `--trace` maps to a per-run trace file in
 * cwd; the flag→config meaning lives in `applyCliFlags` (config.ts), shared
 * with `agency run`/`compile`.
 */
export function agentConfigOverride(args: string[]): Partial<AgencyConfig> {
  const { values } = parseArgs({
    args,
    options: { trace: { type: "string" }, "log-file": { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  const flags: CliFlags = {};
  if ("trace" in values) {
    flags.trace = values.trace === true ? true : String(values.trace);
  }
  if (typeof values["log-file"] === "string") {
    flags.logFile = values["log-file"];
  }
  return applyCliFlags({}, flags);
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

  const overrides = agentConfigOverride(args);
  const env =
    Object.keys(overrides).length > 0
      ? {
          ...process.env,
          [CONFIG_OVERRIDES_ENV]: serializeConfigOverrides(overrides),
        }
      : process.env;

  const nodeProcess = spawn(
    process.execPath,
    [...compiledOutputNodeArgs(), runFile, ...args],
    {
      stdio: "inherit",
      shell: false,
      env,
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
