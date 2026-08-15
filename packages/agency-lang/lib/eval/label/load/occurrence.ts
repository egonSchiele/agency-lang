import type { JsonValue } from "@/utils/canonicalize.js";

import { projectArtifactField } from "../project.js";
import type { Fields } from "../types.js";

import { checkEligibility } from "./eligibility.js";
import type { FinalOutputSelection } from "./run.js";
import type { IngestSkipReason } from "./types.js";

/** The skip reason for an output that could not be selected. Shared by every
 *  loader that resolves a final output, so "no output here" means the same
 *  thing whether the source was a run or a statelog. */
export function skipReasonFor(selection: FinalOutputSelection): IngestSkipReason {
  if (selection.kind === "truncated") {
    return "truncated-output";
  }
  if (selection.kind === "legacy") {
    return "legacy-record";
  }
  return "no-output";
}

/**
 * Turn a resolved (task, output) pair into an example's fields, or a skip
 * reason when the projected output is ineligible.
 *
 * This is the projection every source shares: render the output, check
 * eligibility, and prepend the task when there is one. The occurrence's source
 * and origin are the caller's concern, since those are what differ between a
 * run, a file, a JSON element, and a statelog trace.
 */
export function projectOccurrenceFields(args: {
  /** The task field value, or null to omit it. */
  taskValue: JsonValue | null;
  outputValue: JsonValue;
  constantFields: Fields;
  maxBytes: number;
}): { fields: Fields } | { skipReason: IngestSkipReason } {
  const output = projectArtifactField(args.outputValue);
  const ineligible = checkEligibility(output, { maxBytes: args.maxBytes });
  if (ineligible !== undefined) {
    return { skipReason: ineligible };
  }
  const fields: Fields =
    args.taskValue === null
      ? { ...args.constantFields, output }
      : { task: projectArtifactField(args.taskValue), ...args.constantFields, output };
  return { fields };
}
