import { execFileSync } from "child_process";
import path from "path";
import process from "process";
import { detectPlatform } from "./utils.js";

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
