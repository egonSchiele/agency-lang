import path from "path";

export function _join(parts: string[]): string {
  return path.join(...parts);
}

export function _resolve(parts: string[]): string {
  return path.resolve(...parts);
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

export function _relative(from: string, to: string): string {
  return path.relative(from, to);
}

export function _isAbsolute(p: string): boolean {
  return path.isAbsolute(p);
}
