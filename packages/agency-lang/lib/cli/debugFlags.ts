import type { CliFlags } from "@/config/config.js";
import type { InvocationOptions } from "@/runtime/invocationOptions.js";
import { resolveBudget } from "./budget.js";
import { resolveRunPolicy } from "./runPolicy.js";

/** The run flags `agency debug` shares with `agency run`. The compile
 *  settings (`CliFlags`) are folded onto the config before compiling, as
 *  `run` does; the rest become the invocation the debugged run and every
 *  resume it makes are called with. */
export type DebugRunFlags = CliFlags & {
  policy?: string;
  approve?: string;
  reject?: string;
  maxCost?: string;
  maxTime?: string;
  local?: string;
  draft?: string;
  agencyOnly?: boolean;
};

/** How `agency debug` gets the program it runs. `--agency-only` is
 *  decided first: a safety flag must not be dropped because `agency.json`
 *  points at precompiled output. Naming `--dist-dir` as well contradicts
 *  it, so that pair is refused. */
export function compileChoice(flags: {
  agencyOnly?: boolean;
  distDir?: string;
  configDistDir?: string;
}):
  | { mode: "agency-only" }
  | { mode: "dist-dir"; distDir: string }
  | { mode: "compile" }
  | { refused: string } {
  if (flags.agencyOnly && flags.distDir) {
    return { refused: "--agency-only compiles the program itself; drop --dist-dir." };
  }
  if (flags.agencyOnly) return { mode: "agency-only" };
  const distDir = flags.distDir ?? flags.configDistDir;
  if (distDir) return { mode: "dist-dir", distDir };
  return { mode: "compile" };
}

/** The invocation for a debugged run: the root policy the flags describe
 *  and the budget, in the config's own shape (dollars, and a duration
 *  string checked here so a bad one is refused before anything runs).
 *  `run` carries the same values to its child as environment variables;
 *  the debugger runs the program in its own process, so they travel as
 *  `InvocationOptions`, which a node call, a resume, and a rewind all
 *  take. Throws on a policy or duration that cannot be read. */
export function invocationFromRunFlags(flags: DebugRunFlags, cwd: string): InvocationOptions {
  const invocation: InvocationOptions = {};
  const runPolicy = resolveRunPolicy({
    policy: flags.policy,
    approve: flags.approve,
    reject: flags.reject,
    cwd,
  });
  if (runPolicy) {
    invocation.policy = runPolicy.policy;
  }
  // `resolveBudget` checks both flags and owns their error messages; the
  // values it returns are strings for `run`'s child, so the flags themselves
  // are kept, in the shape `AgencyConfig.budget` takes.
  const checked = resolveBudget({ maxCost: flags.maxCost, maxTime: flags.maxTime });
  const budget: { maxCost?: number; maxTime?: string } = {};
  if (checked.maxCost !== undefined) {
    budget.maxCost = Number(checked.maxCost);
  }
  if (flags.maxTime !== undefined) {
    budget.maxTime = flags.maxTime;
  }
  if (Object.keys(budget).length > 0) {
    invocation.config = { budget };
  }
  return invocation;
}
