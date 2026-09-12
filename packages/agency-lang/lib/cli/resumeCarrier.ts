import fs from "node:fs";
import path from "node:path";
import type { ResumeOverrides } from "../runtime/resumeSetup.js";

export type ResumeCarrier = {
  checkpointFile: string;
  overridesJson: string;
  force: boolean;
};

export function resolveResumeCarrier(
  checkpointFile: string,
  overrides: ResumeOverrides,
  force: boolean,
  cwd = process.cwd(),
): ResumeCarrier {
  const resolved = path.resolve(cwd, checkpointFile);
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch {
    throw new Error(`Checkpoint file does not exist: ${resolved}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Checkpoint path must not be a symlink: ${resolved}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Checkpoint path is not a file: ${resolved}`);
  }
  return { checkpointFile: resolved, overridesJson: JSON.stringify(overrides), force };
}
