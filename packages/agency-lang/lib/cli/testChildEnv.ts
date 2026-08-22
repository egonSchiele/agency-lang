/**
 * The environment a test case's child process gets from the test runner's
 * own flags: the interrupt policy and the root budget, as the runtime reads
 * them (`AGENCY_RUN_POLICY`, `AGENCY_MAX_COST`, `AGENCY_MAX_TIME`).
 *
 * Same clear-then-set discipline as `agency run` (lib/cli/commands.ts): these
 * variables are an internal carrier from THIS invocation's flags to the
 * child, never a knob a parent shell can set behind the user's back. So the
 * four keys are always removed from the inherited environment, and only the
 * ones this run resolved are set again.
 */
import {
  AGENCY_MAX_COST,
  AGENCY_MAX_TIME,
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
} from "@/constants.js";
import type { ResolvedRunPolicy } from "./runPolicy.js";

export type TestChildEnvOptions = {
  policy?: ResolvedRunPolicy;
  /** `resolveBudget`'s shape: dollars and milliseconds, already as strings. */
  budget?: { maxCost?: string; maxTime?: string };
};

export type TestChildEnv = {
  set: Record<string, string>;
  unset: string[];
};

export function testChildEnv(options: TestChildEnvOptions): TestChildEnv {
  const set: Record<string, string> = {};
  if (options.policy !== undefined) set[AGENCY_RUN_POLICY] = options.policy.policyJson;
  if (options.budget?.maxCost !== undefined) set[AGENCY_MAX_COST] = options.budget.maxCost;
  if (options.budget?.maxTime !== undefined) set[AGENCY_MAX_TIME] = options.budget.maxTime;
  return {
    set,
    unset: [AGENCY_RUN_POLICY, AGENCY_RUN_POLICY_INTERACTIVE, AGENCY_MAX_COST, AGENCY_MAX_TIME],
  };
}

/** The child's environment: `base` minus `unset`, plus `set`. */
export function childEnvironment(
  base: NodeJS.ProcessEnv,
  unset: readonly string[],
  set: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of unset) delete env[key];
  return { ...env, ...set };
}
