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

  // Use AppleScript via osascript to send an iMessage
  const script = `
    tell application "Messages"
      set targetService to 1st account whose service type = iMessage
      set targetBuddy to participant "${escapedAppleScript(to)}" of targetService
      send "${escapedAppleScript(message)}" to targetBuddy
    end tell
  `;

  try {
    await execFileAsync("osascript", ["-e", script]);
    return { sent: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to send iMessage: ${msg}`);
  }
}

function escapedAppleScript(str: string): string {
  // Escape backslashes first, then double quotes
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
