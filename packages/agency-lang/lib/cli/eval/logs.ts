import * as fs from "fs";
import * as path from "path";

/**
 * Resolve "the statelog for this run" from the paths a user naturally has
 * in hand: a run directory (its `statelog.jsonl`, which holds every test's
 * trace), a statelog file itself, or — for eval runs written before the run
 * directory — the old per-input layout (`--input` picks one).
 */
export function resolveRunStatelog(target: string, inputId?: string): string {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No such file or directory: ${resolved}`);
  }
  if (fs.statSync(resolved).isFile()) {
    return resolved;
  }
  // a run directory: one statelog holds every test's trace
  const runStatelog = path.join(resolved, "statelog.jsonl");
  if (fs.existsSync(runStatelog)) {
    return runStatelog;
  }
  // LEGACY layouts below (pre-run-directory eval runs on disk).
  // an input directory directly
  const direct = path.join(resolved, "agent", "statelog.jsonl");
  if (fs.existsSync(direct)) {
    return direct;
  }
  // a run directory
  const inputsDir = path.join(resolved, "inputs");
  if (!fs.existsSync(inputsDir)) {
    throw new Error(
      `${resolved} is neither a run directory (no inputs/), an input directory (no agent/statelog.jsonl), nor a statelog file`,
    );
  }
  const ids = fs
    .readdirSync(inputsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const chosen = inputId ?? (ids.length === 1 ? ids[0] : undefined);
  if (chosen === undefined) {
    throw new Error(`Run has ${ids.length} inputs — pick one with --input: ${ids.join(", ")}`);
  }
  const statelogPath = path.join(inputsDir, chosen, "agent", "statelog.jsonl");
  if (!fs.existsSync(statelogPath)) {
    throw new Error(
      inputId !== undefined && !ids.includes(inputId)
        ? `No input "${inputId}" in this run. Inputs: ${ids.join(", ")}`
        : `Test "${chosen}" has no statelog at ${statelogPath} — the run may have failed before the agent started`,
    );
  }
  return statelogPath;
}
