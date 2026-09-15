import { readFileSync } from "node:fs";
import {
  AGENCY_ENTRY_NODE,
  AGENCY_RESUME_FILE,
  AGENCY_RESUME_FORCE,
  AGENCY_RESUME_OVERRIDES,
  EXIT_CODE_USAGE_ERROR,
} from "../constants.js";
import { verifyCheckpointChecksum } from "./checkpointChecksum.js";
import type { ResumeOverrides } from "./resumeSetup.js";
import { Checkpoint } from "./state/checkpointStore.js";

const DEFAULT_ENTRY_NODE = "main";

type CliEntryArgs<T> = {
  /** Every node the compiled file registered on its graph. */
  nodeNames: string[];
  /** Run one of those nodes from the top, as a fresh program. */
  startNode: (nodeName: string) => Promise<T>;
  resume: (checkpoint: Checkpoint, overrides: ResumeOverrides) => Promise<T>;
};

/** Start the node `agency run file.agency:node` named, or `main`. A name the
 *  file does not have is a usage error: print it and exit without the crash
 *  banner and stack trace a thrown error would get. */
function startEntryNode<T>(args: CliEntryArgs<T>): Promise<T> {
  const nodeName = process.env[AGENCY_ENTRY_NODE] || DEFAULT_ENTRY_NODE;
  if (!args.nodeNames.includes(nodeName)) {
    console.error(
      `This file has no node named "${nodeName}". Its nodes are: ${args.nodeNames.join(", ")}`,
    );
    process.exit(EXIT_CODE_USAGE_ERROR);
  }
  return args.startNode(nodeName);
}

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
    return startEntryNode(args);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read checkpoint file "${filename}": ${String(error)}`);
  }

  const checkpoint = Checkpoint.fromJSON(raw);
  if (!checkpoint) {
    throw new Error(`Checkpoint file "${filename}" does not contain a valid Agency checkpoint`);
  }
  if (
    checkpoint.signature !== undefined &&
    process.env[AGENCY_RESUME_FORCE] !== "1" &&
    !verifyCheckpointChecksum(checkpoint)
  ) {
    throw new Error(`Checkpoint file "${filename}" failed checksum verification`);
  }
  return args.resume(checkpoint, parseOverrides(process.env[AGENCY_RESUME_OVERRIDES]));
}
