import type { CliFlags } from "@/config/config.js";
import type { InvocationOptions } from "@/runtime/invocationOptions.js";
import { parseDurationMs } from "@/duration.js";
import { resolveRunPolicy } from "./runPolicy.js";

/** The run flags `agency debug` shares with `agency run`. The compile
 *  settings (`CliFlags`) are folded onto the config before compiling, as
 *  `run` does; the rest become the invocation the debugged run and every
 *  resume it makes are called with. */
export type DebugRunFlags = CliFlags & {
  policy?: string;
  approve?: string;
  reject?: string;
  /** Accepted for symmetry with `run`. The debugger prompts for every
   *  interrupt no handler answers, so it is always interactive. */
  interactive?: boolean;
  maxCost?: string;
  maxTime?: string;
  local?: string;
  draft?: string;
  agencyOnly?: boolean;
};

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
  if (runPolicy) invocation.policy = runPolicy.policy;
  const budget: { maxCost?: number; maxTime?: string } = {};
  if (flags.maxCost !== undefined) {
    const dollars = Number(flags.maxCost);
    if (!Number.isFinite(dollars)) {
      throw new Error(`--max-cost: expected a number of dollars (got "${flags.maxCost}")`);
    }
    budget.maxCost = dollars;
  }
  if (flags.maxTime !== undefined) {
    parseDurationMs(flags.maxTime, "--max-time");
    budget.maxTime = flags.maxTime;
  }
  if (Object.keys(budget).length > 0) invocation.config = { budget };
  return invocation;
}
