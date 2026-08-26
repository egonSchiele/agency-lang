import * as fs from "fs";
import * as path from "path";

/** Read one file the agent left in its workdir, by path relative to the
 *  workdir. "" when the file is missing or the path escapes the workdir. */
export function readWorkdirFile(workdir: string, relativePath: string): string {
  if (workdir === "" || relativePath === "") return "";
  const root = path.resolve(workdir);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(root + path.sep)) return "";
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return "";
  }
}
