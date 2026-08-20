import {
  AgencyConfig,
  applyCliFlags,
  CONFIG_OVERRIDES_ENV,
  mergeConfigOverrides,
  readConfigOverrides,
  serializeConfigOverrides,
  type CliFlags,
} from "@/config.js";
import { resolveBudget } from "./budget.js";
import { stageConfiguredAgent } from "./stageConfiguredAgent.js";
import { compiledOutputNodeArgs } from "./commands.js";
import { compile } from "@/compiler/defaultSession.js";
import { AGENCY_MAX_COST, AGENCY_MAX_TIME } from "@/constants.js";
import { spawn as realSpawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { withCodeIdentity } from "@/runDirectory/codeIdentity.js";

const currentDir = path.dirname(new URL(import.meta.url).pathname);

/**
 * The launcher pre-scan policy: the flags that must take effect BEFORE the
 * agent process exists, and how each treats a missing value. This table and
 * the one scan below are the single place launcher flags are recognized —
 * every bundled agent gets them by going through `runBundledAgent`; the
 * agency-agent's own schema declares them too, for --help and its parser.
 *
 * Membership is deliberately minimal (a pre-scan is a wart to keep small):
 * config-shaped flags are consumed by static initialization, and trace/log/
 * budget applied late would change what the feature means (a trace with a
 * hole at startup; a spend cap that depends on agent-code discipline).
 */
// A bare flag always scans to "" here; what "" MEANS is decided in
// resolveAgentLaunchArgs (meaningful default destination for trace/log,
// absent for the rest — the agent's own parser reports the missing value).
const LAUNCH_FLAG_POLICIES: Record<
  string,
  {
    /** Budget values may be negative numbers, which look like flags. */
    acceptsNegativeNumber: boolean;
  }
> = {
  trace: { acceptsNegativeNumber: false },
  log: { acceptsNegativeNumber: false },
  "agent-home": { acceptsNegativeNumber: false },
  workdir: { acceptsNegativeNumber: false },
  "max-cost": { acceptsNegativeNumber: true },
  "max-time": { acceptsNegativeNumber: true },
  config: { acceptsNegativeNumber: false },
};

const NEGATIVE_NUMBER = /^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/;

/**
 * One raw-token walk over the forwarded argv. A required value is the next
 * token unless that token is absent or another option (matching what the
 * agent's own std::args parser does, so the two never disagree about what is
 * a value); budget flags additionally accept a negative number. `--flag=value`
 * attaches, `--` terminates, repeats are last-wins. Never mutates `args`.
 */
function scanLaunchValues(args: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") break;
    if (!token.startsWith("--")) continue;
    const equalsIndex = token.indexOf("=");
    const name = equalsIndex === -1 ? token.slice(2) : token.slice(2, equalsIndex);
    const policy = LAUNCH_FLAG_POLICIES[name];
    if (policy === undefined) continue;
    if (equalsIndex !== -1) {
      values[name] = token.slice(equalsIndex + 1);
      continue;
    }
    const next = args[index + 1];
    const nextIsValue =
      next !== undefined &&
      next !== "--" &&
      (!next.startsWith("-") || (policy.acceptsNegativeNumber && NEGATIVE_NUMBER.test(next)));
    if (nextIsValue) {
      values[name] = next;
      index += 1;
    } else {
      values[name] = "";
    }
  }
  return values;
}

export type ResolvedAgentLaunch = {
  configOverrides: Partial<AgencyConfig>;
  agentHome: string | null;
  /** A forwarded `--workdir <dir>`: the child's working directory, absolute.
   *  It must be the SPAWN cwd — the agent's static initializers resolve
   *  paths and discover agency.json against cwd before main() runs. */
  workdir: string | null;
  budgetInput: { maxCost?: string; maxTime?: string };
  /** A forwarded `--config <path>`; wins over the root-level `-c`. */
  configPath?: string;
};

/** Launch behavior callers may set; test seams live in the separate
 *  dependencies parameter, never here. */
export type AgentLaunchOptions = {
  /** An explicit root `-c <path>` — set only when the user wrote the flag
   *  (cwd config discovery never sets it), which is the provenance the
   *  staged configured compile needs. */
  explicitConfigPath?: string;
};

/** The launcher's environment seams, injectable for orchestration tests.
 *  Every field is used by exactly the branch it controls. */
export type RunBundledAgentDependencies = {
  resolveAgentDir: (agentName: string) => string;
  fileExists: (file: string) => boolean;
  stageConfiguredAgent: typeof stageConfiguredAgent;
  compile: typeof compile;
  spawn: typeof realSpawn;
  exit: (code: number) => void;
};

const DEFAULT_RUN_BUNDLED_AGENT_DEPENDENCIES: RunBundledAgentDependencies = {
  resolveAgentDir: (agentName) => path.resolve(currentDir, `../agents/${agentName}`),
  fileExists: (file) => fs.existsSync(file),
  stageConfiguredAgent,
  compile,
  spawn: realSpawn,
  exit: (code) => process.exit(code),
};

/**
 * The semantic result of the launcher pre-scan: trace/log projected into a
 * config override (the flag→config meaning lives in `applyCliFlags`; a bare
 * `--trace` maps to a per-run trace file in cwd, `--log stdout` to the stdout
 * sink), agent-home resolved to an absolute path (the child would otherwise
 * resolve a relative one against its own cwd) or null, and the raw budget
 * inputs for `resolveBudget` validation. Callers never interpret scanner
 * state, and the input array is never modified — the child always receives
 * the original argv.
 */
export function resolveAgentLaunchArgs(args: readonly string[]): ResolvedAgentLaunch {
  const scanned = scanLaunchValues(args);
  const flags: CliFlags = {};
  if (scanned.trace !== undefined) {
    flags.trace = scanned.trace;
  }
  if (scanned.log !== undefined) {
    if (scanned.log.toLowerCase() === "stdout") {
      flags.logStdout = true;
    } else {
      flags.logFile = scanned.log === "" ? "log.jsonl" : scanned.log;
    }
  }
  const home = scanned["agent-home"];
  const nonEmpty = (value: string | undefined) =>
    value !== undefined && value !== "" ? value : undefined;
  const workdir = scanned.workdir;
  return {
    configOverrides: applyCliFlags({}, flags),
    agentHome: home !== undefined && home !== "" ? path.resolve(home) : null,
    workdir: workdir !== undefined && workdir !== "" ? path.resolve(workdir) : null,
    budgetInput: {
      maxCost: nonEmpty(scanned["max-cost"]),
      maxTime: nonEmpty(scanned["max-time"]),
    },
    configPath: nonEmpty(scanned.config),
  };
}

export function runBundledAgent(
  config: AgencyConfig,
  agentName: string,
  args: string[] = [],
  options: AgentLaunchOptions = {},
  deps: Partial<RunBundledAgentDependencies> = {},
): void {
  const launcher = { ...DEFAULT_RUN_BUNDLED_AGENT_DEPENDENCIES, ...deps };
  const agentDir = launcher.resolveAgentDir(agentName);
  const agencyFile = path.join(agentDir, "agent.agency");
  const precompiledFile = path.join(agentDir, "agent.js");

  // Parse, validate, and project the launcher flags in one place — before
  // choosing a run file or spawning. An invalid budget never launches.
  const launchArgs = resolveAgentLaunchArgs(args);
  let budget: { maxCost?: string; maxTime?: string };
  try {
    budget = resolveBudget(launchArgs.budgetInput);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    launcher.exit(2);
    return;
  }

  // A bad workdir never launches: the agent would silently run somewhere
  // the user did not intend, which is exactly what the flag exists to fix.
  if (launchArgs.workdir !== null && !isDirectory(launchArgs.workdir)) {
    console.error(`Error: --workdir ${launchArgs.workdir} is not a directory.`);
    launcher.exit(2);
    return;
  }

  // An explicit config recompiles the agent in an isolated staged tree —
  // baked fields (model, limits) never cross the override-env transport, and
  // the shipped agent.js must never be overwritten. The forwarded
  // `agent --config` beats the root `-c` (the more specific value). Without
  // an explicit config: the precompiled fast path, falling back to a fresh
  // compile only when the bundle has not been built.
  const explicitConfig = launchArgs.configPath ?? options.explicitConfigPath;
  let runFile: string | null;
  let cleanup: () => void = () => {};
  if (explicitConfig !== undefined) {
    try {
      ({ runFile, cleanup } = launcher.stageConfiguredAgent(explicitConfig, agentDir));
    } catch (error) {
      // A bad explicit config never launches — and never becomes an
      // unconfigured run of the shipped agent.
      console.error(`Error: ${(error as Error).message}`);
      launcher.exit(2);
      return;
    }
  } else if (launcher.fileExists(precompiledFile)) {
    runFile = precompiledFile;
  } else {
    runFile = launcher.compile(config, agencyFile);
  }
  if (runFile === null) {
    cleanup();
    console.error(`Failed to compile agent ${agentName}.`);
    launcher.exit(1);
    return;
  }

  const env = { ...process.env };
  // Inherited overrides matter: an eval harness hands this process its
  // statelog path via this env var, and flags must layer on top, not
  // replace it. The code identity goes on last: it names the agent that is
  // actually about to run, so neither an inherited `log.code` nor a flag may
  // replace it.
  const merged = withCodeIdentityIfSourced(
    mergeConfigOverrides(readConfigOverrides(env), launchArgs.configOverrides),
    agencyFile,
  );
  if (Object.keys(merged).length > 0) {
    env[CONFIG_OVERRIDES_ENV] = serializeConfigOverrides(merged);
  }
  // The agent home must be in the env before the child starts: the agent's
  // config module derives its settings/policy/history paths from it in
  // static-const initializers, which run before the agent's main() could
  // parse any flag. The flag beats an inherited AGENCY_AGENT_HOME.
  if (launchArgs.agentHome !== null) {
    env.AGENCY_AGENT_HOME = launchArgs.agentHome;
  }
  // Root budget carrier: cleared-then-set like AGENCY_RUN_POLICY, so a
  // stale value from the parent shell never constrains the agent.
  delete env[AGENCY_MAX_COST];
  delete env[AGENCY_MAX_TIME];
  if (budget.maxCost !== undefined) env[AGENCY_MAX_COST] = budget.maxCost;
  if (budget.maxTime !== undefined) env[AGENCY_MAX_TIME] = budget.maxTime;

  // Cleanup ownership: staging owns it until spawn succeeds, then the
  // child's handlers own it. A synchronous spawn throw cleans up here.
  let nodeProcess: ReturnType<typeof realSpawn>;
  try {
    nodeProcess = launcher.spawn(
      process.execPath,
      [...compiledOutputNodeArgs(), runFile, ...args],
      {
        stdio: "inherit",
        shell: false,
        env,
        // The child's cwd, not a parent chdir: the launcher keeps resolving
        // its own files (agent dir, staging) where they actually live.
        cwd: launchArgs.workdir ?? undefined,
      },
    );
  } catch (error) {
    cleanup();
    throw error;
  }

  nodeProcess.on("error", (error) => {
    cleanup();
    console.error(`Failed to run ${agentName}:`, error);
    launcher.exit(1);
  });

  nodeProcess.on("exit", (code) => {
    cleanup();
    if (code !== 0) {
      console.error(`${agentName} exited with code ${code}.`);
      launcher.exit(code || 1);
    }
  });
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Which code the agent is, for the trace's agentStart. A precompiled agent
 *  shipped without its `.agency` source records nothing. */
function withCodeIdentityIfSourced(
  overrides: Partial<AgencyConfig>,
  agencyFile: string,
): Partial<AgencyConfig> {
  if (!fs.existsSync(agencyFile)) return overrides;
  return withCodeIdentity(overrides, agencyFile);
}
