import fs from "fs";
import path from "path";
import { getModuleDir } from "../runtime/asyncContext.js";

/**
 * Read a skill file colocated with the calling Agency module. The
 * `filepath` is resolved against the module's directory (the directory
 * of the compiled `.js`, which by convention is the directory of the
 * source `.agency` file) via the ALS frame seeded by `runNode` /
 * `runInBootstrapFrame`. Falls back to `process.cwd()` when called
 * outside any Agency execution frame (e.g. from non-Agency host code).
 */
export function _readSkill(filepath: string): string {
  const dirname = getModuleDir();
  const fullPath = path.resolve(dirname, filepath);
  return fs.readFileSync(fullPath, "utf8");
}
