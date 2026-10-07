import path from "#path";

/** Whether the path module follows Windows rules, where two spellings of
 *  a path that differ in case name the same file. */
export const WINDOWS_PATHS = path.sep === "\\";

/** True when `target` is `root` or sits inside it. Both are spelled the
 *  way file effects spell their payloads: real, absolute paths. Uses
 *  `path.relative` so a root of `/` works. Case-insensitive under
 *  Windows path rules. */
export function isContained(target: string, root: string): boolean {
  const t = WINDOWS_PATHS ? target.toLowerCase() : target;
  const r = WINDOWS_PATHS ? root.toLowerCase() : root;
  if (t === r) {
    return true;
  }
  const rel = path.relative(r, t);
  if (rel === "") {
    return true;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return rel.split(path.sep)[0] !== "..";
}
