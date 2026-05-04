import { execFileSync, execFile } from "child_process";
import path from "path";
import process from "process";
import { detectPlatform } from "./utils.js";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function _args(): string[] {
  return process.argv.slice(2);
}

export function _cwd(): string {
  return process.cwd();
}

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

/**
 * Open a URL in the user's default browser.
 * Currently macOS-only (uses the `open` command). Throws on other platforms.
 */
export async function _openUrl(url: string): Promise<void> {
  const platform = detectPlatform();

  if (platform === "macos") {
    await execFileAsync("open", ["--", url]);
  } else {
    throw new Error(
      `openUrl is currently only supported on macOS (detected: ${platform}). ` +
      `Cross-platform support will be added in a future release.`,
    );
  }
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
