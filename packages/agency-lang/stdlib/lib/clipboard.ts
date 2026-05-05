import { execFile } from "child_process";
import { promisify } from "util";
import { detectPlatform } from "./utils.js";

const execFileAsync = promisify(execFile);

export async function _copy(text: string): Promise<void> {
  const platform = await detectPlatform();
  if (platform === "macos") {
    await execFileAsync("pbcopy", [], { input: text } as any);
  } else if (platform === "linux") {
    await execFileAsync("xclip", ["-selection", "clipboard"], { input: text } as any);
  } else {
    console.error(
      `copy is not supported on platform: ${platform}. ` +
      `Supported platforms: macOS, Linux.`
    );
  }
}

export async function _paste(): Promise<string> {
  const platform = await detectPlatform();
  if (platform === "macos") {
    const { stdout } = await execFileAsync("pbpaste");
    return stdout;
  } else if (platform === "linux") {
    const { stdout } = await execFileAsync("xclip", ["-selection", "clipboard", "-o"]);
    return stdout;
  } else {
    console.error(
      `paste is not supported on platform: ${platform}. ` +
      `Supported platforms: macOS, Linux.`
    );
    return "";
  }
}
