import { execFileSync } from "child_process";
import path from "path";
import process from "process";
import { detectPlatform } from "./utils.js";

export function _env(name: string): string | null {
  const v = process.env[name];
  return v === undefined ? null : v;
}

export function _setEnv(name: string, value: string): void {
  if (name.length === 0) {
    throw new Error("setEnv: name must not be empty");
  }
  if (name.includes("=") || name.includes("\0")) {
    throw new Error(
      `setEnv: name must not contain '=' or NUL bytes (got ${JSON.stringify(name)})`,
    );
  }
  if (value.includes("\0")) {
    throw new Error("setEnv: value must not contain NUL bytes");
  }
  process.env[name] = value;
}

export function _screenshot(
  filepath: string,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const platform = detectPlatform();
  const resolvedPath = path.resolve(process.cwd(), filepath);
  const hasRegion = x >= 0 && y >= 0 && width >= 0 && height >= 0;

  if (platform === "macos") {
    if (hasRegion) {
      execFileSync("screencapture", ["-R", `${x},${y},${width},${height}`, resolvedPath]);
    } else {
      execFileSync("screencapture", ["-x", resolvedPath]);
    }
  } else if (platform === "linux") {
    if (hasRegion) {
      execFileSync("import", ["-crop", `${width}x${height}+${x}+${y}`, "-window", "root", resolvedPath]);
    } else {
      execFileSync("import", ["-window", "root", resolvedPath]);
    }
  } else {
    console.error(
      `screenshot is not supported on platform: ${platform}. ` +
      `Supported platforms: macOS, Linux.`
    );
  }
}
