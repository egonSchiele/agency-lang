import path from "#path";
import { currentHost } from "../runtime/currentHost.js";

export function _join(parts: string[]): string {
  return path.join(...parts);
}

/** Resolves from the run's working directory, like `path.resolve`
 *  does from the process's. */
export function _resolve(parts: string[]): string {
  const host = currentHost();
  return path.resolve(host.system.cwd(), ...parts);
}

export function _basename(p: string, ext: string): string {
  return ext === "" ? path.basename(p) : path.basename(p, ext);
}

export function _dirname(p: string): string {
  return path.dirname(p);
}

export function _extname(p: string): string {
  return path.extname(p);
}

/** Resolves both paths from the run's working directory first, like
 *  `path.relative` does from the process's. */
export function _relative(from: string, to: string): string {
  const host = currentHost();
  const cwd = host.system.cwd();
  return path.relative(path.resolve(cwd, from), path.resolve(cwd, to));
}

export function _isAbsolute(p: string): boolean {
  return path.isAbsolute(p);
}
