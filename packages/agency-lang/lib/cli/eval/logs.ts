import * as fs from "fs";
import * as path from "path";

/**
 * Resolve "the statelog for this run" from the paths a user naturally has
 * in hand: a run directory (one input → that input's statelog; several →
 * --input picks, and the error lists the choices), a single input's
 * directory (runs/<id>/inputs/<inputId>), or a statelog file itself.
 */
export function resolveRunStatelog(target: string, inputId?: string): string {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No such file or directory: ${resolved}`);
  }
  if (fs.statSync(resolved).isFile()) {
    return resolved;
  }
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
  const ids = fs.readdirSync(inputsDir, { withFileTypes: true })
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
        : `Input "${chosen}" has no statelog at ${statelogPath} — the run may have failed before the agent started`,
    );
  }
  return statelogPath;
}
