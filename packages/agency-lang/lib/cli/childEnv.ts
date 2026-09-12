/**
 * The root policy and budget a CLI command carries to the Agency program it
 * spawns, as env vars the runtime reads (`installRunPolicyHandler`,
 * `rootBudget`). Always cleared first: a child's behavior comes from this
 * invocation's flags, never from a parent shell or an outer run.
 */
import {
  AGENCY_MAX_COST,
  AGENCY_MAX_TIME,
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_RUN_POLICY_INTERACTIVE_ON,
  AGENCY_RESUME_FILE,
  AGENCY_RESUME_FORCE,
  AGENCY_RESUME_OVERRIDES,
} from "@/constants.js";
import type { ResumeCarrier } from "./resumeCarrier.js";

export type RootCarriers = {
  policy?: { policyJson: string; interactive?: boolean };
  /** `resolveBudget`'s shape: dollars and milliseconds as strings. */
  budget?: { maxCost?: string; maxTime?: string };
  resume?: ResumeCarrier;
};

export function withRootCarriers(
  env: NodeJS.ProcessEnv,
  carriers: RootCarriers,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out[AGENCY_RUN_POLICY];
  delete out[AGENCY_RUN_POLICY_INTERACTIVE];
  delete out[AGENCY_MAX_COST];
  delete out[AGENCY_MAX_TIME];
  delete out[AGENCY_RESUME_FILE];
  delete out[AGENCY_RESUME_OVERRIDES];
  delete out[AGENCY_RESUME_FORCE];
  if (carriers.policy !== undefined) {
    out[AGENCY_RUN_POLICY] = carriers.policy.policyJson;
    if (carriers.policy.interactive)
      out[AGENCY_RUN_POLICY_INTERACTIVE] = AGENCY_RUN_POLICY_INTERACTIVE_ON;
  }
  if (carriers.budget?.maxCost !== undefined) out[AGENCY_MAX_COST] = carriers.budget.maxCost;
  if (carriers.budget?.maxTime !== undefined) out[AGENCY_MAX_TIME] = carriers.budget.maxTime;
  if (carriers.resume !== undefined) {
    out[AGENCY_RESUME_FILE] = carriers.resume.checkpointFile;
    out[AGENCY_RESUME_OVERRIDES] = carriers.resume.overridesJson;
    if (carriers.resume.force) {
      out[AGENCY_RESUME_FORCE] = "1";
    }
  }
  return out;
}
