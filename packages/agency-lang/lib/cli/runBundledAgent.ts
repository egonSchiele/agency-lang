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

// The flags every bundled agent understands that this launcher pre-scans
// out of the forwarded argv (the agent also declares them, for --help).
const AGENT_PRESCAN_FLAGS = ["--trace", "--log-file", "--agent-home"] as const;

/**
 * Rewrite a bare pre-scanned flag to its empty attached form (`--trace` →
 * `--trace=`) when its next token is absent or starts with `-`. This
 * replicates exactly what `std::args` does before parsing
 * (lib/stdlib/args.ts:499-505), so the agent's own parser and this pre-scan
 * agree: `--trace --print` and `--trace -p` are BOTH bare here, not a trace
 * file named "--print" / "-p". Stops at the `--` terminator (everything after
 * is positional).
 */
function normalizeBareFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") {
      out.push(...args.slice(i));
      break;
    }
    if ((AGENT_PRESCAN_FLAGS as readonly string[]).includes(token)) {
      const next = args[i + 1];
      const bare = next === undefined || next === "--" || next.startsWith("-");
      out.push(bare ? `${token}=` : token);
    } else {
      out.push(token);
    }
  }
  return out;
}

/**
 * Extract the debug flags (`--trace`, `--log-file`) from a bundled agent's
 * forwarded argv, as a config override. This is the ONE place these flags are
 * handled — every bundled agent gets them for free by going through
 * `runBundledAgent`; no agent writes flag code.
 *
 * Tokenization is `node:util.parseArgs` (which `std::args` is itself built on)
 * after the same bare-flag normalization std::args applies, so `--flag=value`,
 * the `--` terminator, last-wins-on-repeat, AND a following-flag-is-not-a-value
 * all match the agent's own parser. An empty/bare `--trace` maps to a per-run
 * trace file in cwd; the flag→config meaning lives in `applyCliFlags`.
 */
export function agentConfigOverride(args: string[]): Partial<AgencyConfig> {
  const { values } = parseArgs({
    args: normalizeBareFlags(args),
    options: { trace: { type: "string" }, "log-file": { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  const flags: CliFlags = {};
  // After normalization a present --trace is always a string ("" when bare).
  if (typeof values.trace === "string") {
    flags.trace = values.trace;
  }
  // --log-file requires a value; a bare (now "") --log-file is ignored.
  if (typeof values["log-file"] === "string" && values["log-file"] !== "") {
    flags.logFile = values["log-file"];
  }
  return applyCliFlags({}, flags);
}

/**
 * Extract `--agent-home <dir>` — the flag form of the AGENCY_AGENT_HOME env
 * var — from a bundled agent's forwarded argv, using the same pre-scan
 * tokenization rules as `agentConfigOverride`. Returns the directory resolved
 * to an absolute path (the child would otherwise resolve a relative one
 * against whatever its cwd happens to be), or null when the flag is absent or
 * bare. A bare `--agent-home` is a usage error the agent's own parser
 * reports, so it is only skipped here, never defaulted.
 */
export function agentHomeOverride(args: string[]): string | null {
  const { values } = parseArgs({
    args: normalizeBareFlags(args),
    options: { "agent-home": { type: "string" } },
    strict: false,
    allowPositionals: true,
  });
  const home = values["agent-home"];
  if (typeof home !== "string" || home === "") {
    return null;
  }
  return path.resolve(home);
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
  const agentHome = agentHomeOverride(args);
  const env = { ...process.env };
  if (Object.keys(overrides).length > 0) {
    env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides(overrides);
  }
  // The agent home must be in the env before the child starts: the agent's
  // config module derives its settings/policy/history paths from it in
  // static-const initializers, which run before the agent's main() could
  // parse any flag. The flag beats an inherited AGENCY_AGENT_HOME.
  if (agentHome !== null) {
    env.AGENCY_AGENT_HOME = agentHome;
  }

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
