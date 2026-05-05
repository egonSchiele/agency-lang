import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type IMessageResult = {
  sent: boolean;
};

export async function _sendIMessage(
  to: string,
  message: string
): Promise<IMessageResult> {
  if (process.platform !== "darwin") {
    throw new Error("iMessage is only available on macOS.");
  }

  if (!to) {
    throw new Error("Missing recipient. Provide a phone number or email address.");
  }

  if (!message) {
    throw new Error("Missing message body.");
  }

  const script = `
    tell application "Messages"
      set targetService to 1st account whose service type = iMessage
      set targetBuddy to participant "${escapeAppleScriptString(to)}" of targetService
      send "${escapeAppleScriptString(message)}" to targetBuddy
    end tell
  `;

  try {
    await execFileAsync("osascript", ["-e", script]);
    return { sent: true };
  } catch (error: unknown) {
    // Avoid leaking script contents (which contain recipient/message) into error messages.
    // execFile errors include stderr which has the actionable info.
    const err = error as { stderr?: string; code?: number };
    const detail = err.stderr?.trim() || `exit code ${err.code ?? "unknown"}`;
    throw new Error(`Failed to send iMessage: ${detail}`);
  }
}

function escapeAppleScriptString(str: string): string {
  // Escape backslashes, double quotes, and replace characters that would
  // terminate an AppleScript string literal or inject new statements.
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, "\\n")
    .replace(/\r/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\u2028/g, "\\n")
    .replace(/\u2029/g, "\\n");
}
