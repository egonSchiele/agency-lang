import { currentHost } from "../runtime/currentHost.js";
import { runProgram } from "./abortable.js";
import { detectPlatform } from "./utils.js";

// The desktop notification behind `notify` in std::system. It runs a
// subprocess, so it lives apart from builtins.ts, which backs the prelude
// and must not import child_process.

/** argv item 1 is the message, item 2 is the title. See `_notify`. */
const NOTIFY_SCRIPT = `on run argv
  display notification (item 1 of argv) with title (item 2 of argv)
end run`;

export async function _notify(title: string, message: string): Promise<boolean> {
  const host = currentHost();
  const platform = await detectPlatform();
  if (platform === "macos") {
    // The title and message arrive as argv rather than being spliced into the
    // script source, so AppleScript never parses them as code. `notify` is
    // reachable from model-authored text, and escaping only holds for as long
    // as the escape function keeps up with every AppleScript metacharacter.
    // No "-" before the arguments: osascript would pass it through as argv
    // item 1 and shift every real argument by one.
    await runProgram(host, "osascript", ["-e", NOTIFY_SCRIPT, message, title]);
  } else if (platform === "linux") {
    await runProgram(host, "notify-send", [title, message]);
  } else if (platform === "wsl") {
    console.error(
      `notify is not yet supported in WSL. ` +
        `WSL does not have reliable notification support.\n` +
        `Title: ${title}\nMessage: ${message}`,
    );
  } else if (platform === "windows") {
    console.error(
      `notify is not yet supported on Windows. ` +
        `Supported platforms: macOS, Linux.\n` +
        `Title: ${title}\nMessage: ${message}`,
    );
  } else {
    console.error(
      `notify is not supported on platform: ${platform}\n` + `Title: ${title}\nMessage: ${message}`,
    );
  }
  return true;
}
