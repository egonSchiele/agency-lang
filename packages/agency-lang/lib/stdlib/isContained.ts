import path from "path";
import process from "process";

/** True when `target` is `root` or sits inside it. Both are spelled the
 *  way file effects spell their payloads: real, absolute paths. Uses
 *  `path.relative` so a root of `/` works. Case-insensitive on Windows. */
export function isContained(target: string, root: string): boolean {
  const t = process.platform === "win32" ? target.toLowerCase() : target;
  const r = process.platform === "win32" ? root.toLowerCase() : root;
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
