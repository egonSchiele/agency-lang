import type { Host } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { program, runProgram } from "./abortable.js";
import { detectPlatform } from "./utils.js";

/** Hand `input` to the program and wait for it, whatever its exit code. */
async function runWithInput(
  host: Host,
  name: string,
  args: string[],
  input: string,
): Promise<void> {
  await host.subprocess.run(program(name, args), {
    input,
    collect: { stdout: false, stderr: false },
  });
}

export async function _copy(text: string): Promise<void> {
  const host = currentHost();
  const platform = await detectPlatform();
  if (platform === "macos") {
    await runWithInput(host, "pbcopy", [], text);
  } else if (platform === "linux") {
    await runWithInput(host, "xclip", ["-selection", "clipboard"], text);
  } else {
    console.error(
      `copy is not supported on platform: ${platform}. ` + `Supported platforms: macOS, Linux.`,
    );
  }
}

export async function _paste(): Promise<string> {
  const host = currentHost();
  const platform = await detectPlatform();
  if (platform === "macos") {
    const { stdout } = await runProgram(host, "pbpaste", []);
    return stdout;
  } else if (platform === "linux") {
    const { stdout } = await runProgram(host, "xclip", ["-selection", "clipboard", "-o"]);
    return stdout;
  } else {
    console.error(
      `paste is not supported on platform: ${platform}. ` + `Supported platforms: macOS, Linux.`,
    );
    return "";
  }
}
