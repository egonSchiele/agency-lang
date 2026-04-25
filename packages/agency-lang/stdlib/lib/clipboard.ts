import { execFileSync } from "child_process";
import { detectPlatform } from "./utils.js";

export function _copy(text: string): void {
  const platform = detectPlatform();
  if (platform === "macos") {
    execFileSync("pbcopy", [], { input: text });
  } else if (platform === "linux") {
    execFileSync("xclip", ["-selection", "clipboard"], { input: text });
  } else {
    console.error(
      `copy is not supported on platform: ${platform}. ` +
      `Supported platforms: macOS, Linux.`
    );
  }
}

export function _paste(): string {
  const platform = detectPlatform();
  if (platform === "macos") {
    return execFileSync("pbpaste").toString();
  } else if (platform === "linux") {
    return execFileSync("xclip", ["-selection", "clipboard", "-o"]).toString();
  } else {
    console.error(
      `paste is not supported on platform: ${platform}. ` +
      `Supported platforms: macOS, Linux.`
    );
    return "";
  }
}
