import { nanoid } from "nanoid";
import type { Host } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { failure, success, type ResultValue } from "../runtime/result.js";
import { program, ProgramFailed, runProgram } from "./abortable.js";

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
  const platform = host.system.operatingSystem();
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
  const platform = host.system.operatingSystem();
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

// Writes the clipboard's image, as PNG, to the path given as the script's
// argument. The path is an argument and never part of the script text.
const CLIPBOARD_PNG_SCRIPT = [
  "on run argv",
  "set png to (the clipboard as «class PNGf»)",
  "set target to open for access POSIX file (item 1 of argv) with write permission",
  "write png to target",
  "close access target",
  "end run",
];

/** Save the image on the clipboard to a new PNG file in the temp directory
 *  and return its path. A failure when the clipboard holds no image, or on
 *  a system other than macOS. */
export async function _pasteImage(): Promise<ResultValue> {
  const host = currentHost();
  if (host.system.operatingSystem() !== "macos") {
    return failure("Pasting an image from the clipboard works on macOS only.");
  }
  const tempDir = await host.files.root(host.system.tempDir());
  const file = await host.files.resolvePath(tempDir, `agency-clipboard-${nanoid()}.png`);
  const scriptArgs = CLIPBOARD_PNG_SCRIPT.flatMap((line) => ["-e", line]);
  try {
    await runProgram(host, "osascript", [...scriptArgs, file]);
  } catch (err) {
    if (err instanceof ProgramFailed) {
      return failure("The clipboard does not hold an image.");
    }
    throw err;
  }
  return success(file);
}
