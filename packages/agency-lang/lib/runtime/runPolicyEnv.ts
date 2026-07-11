// The env-var wire contract between `agency run` (writer, lib/cli/commands.ts)
// and the runtime root handler (reader, runPolicyHandler.ts). Defined once so
// the two sides agree by construction.
export const AGENCY_RUN_POLICY = "AGENCY_RUN_POLICY";
export const AGENCY_RUN_POLICY_INTERACTIVE = "AGENCY_RUN_POLICY_INTERACTIVE";
export const INTERACTIVE_ON = "1";
