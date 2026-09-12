import { readFileSync } from "node:fs";
import { AGENCY_RESUME_FILE, AGENCY_RESUME_OVERRIDES } from "../constants.js";
import { verifyCheckpointChecksum } from "./checkpointChecksum.js";
import type { ResumeOverrides } from "./resumeSetup.js";
import { Checkpoint } from "./state/checkpointStore.js";

type CliEntryArgs<T> = {
  runMain: () => Promise<T>;
  resume: (checkpoint: Checkpoint, overrides: ResumeOverrides) => Promise<T>;
};

function parseOverrides(raw: string | undefined): ResumeOverrides {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${AGENCY_RESUME_OVERRIDES} is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${AGENCY_RESUME_OVERRIDES} must be a JSON object`);
  }
  for (const bucket of ["locals", "args", "globals"] as const) {
    const value = (parsed as Record<string, unknown>)[bucket];
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      throw new Error(`${AGENCY_RESUME_OVERRIDES}.${bucket} must be a JSON object`);
    }
    if (value && Object.prototype.hasOwnProperty.call(value, "__proto__")) {
      throw new Error(`${AGENCY_RESUME_OVERRIDES}.${bucket} contains an invalid variable name`);
    }
  }
  return parsed as ResumeOverrides;
}

export async function runCliEntry<T>(args: CliEntryArgs<T>): Promise<T> {
  const filename = process.env[AGENCY_RESUME_FILE];
  if (!filename) {
    return args.runMain();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read checkpoint file "${filename}": ${String(error)}`);
  }

  const key = process.env.AGENCY_CHECKPOINT_KEY;
  if (key !== undefined && key !== "" && !verifyCheckpointChecksum(raw as any)) {
    throw new Error(`Checkpoint file "${filename}" failed checksum verification`);
  }

  const checkpoint = Checkpoint.fromJSON(raw);
  if (!checkpoint) {
    throw new Error(`Checkpoint file "${filename}" does not contain a valid Agency checkpoint`);
  }
  return args.resume(checkpoint, parseOverrides(process.env[AGENCY_RESUME_OVERRIDES]));
}
