import { execFile } from "child_process";
import { promisify } from "util";
import { checkRecipients } from "./messaging.js";

const execFileAsync = promisify(execFile);

/** The recipient and the message body arrive as argv, never spliced into this
 *  source. That matters here more than usual: `sendIMessage` is handed to an
 *  LLM as a tool, so the body is model-authored text that may echo a web page,
 *  an email, or a file the agent read. AppleScript does not parse argv values
 *  as code, so a body like `" & (do shell script "...") & "` is just a string.
 *
 *  Escaping the data into the source would also work only for as long as the
 *  escape function keeps up with every AppleScript metacharacter. Passing
 *  arguments removes the question instead of answering it repeatedly. */
const SEND_SCRIPT = `on run argv
  set recipientId to item 1 of argv
  set messageBody to item 2 of argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant recipientId of targetService
    send messageBody to targetBuddy
  end tell
end run`;

export type IMessageResult = {
  sent: boolean;
};

export type IMessageOptions = {
  allowList?: string[];
  blockList?: string[];
};

export async function _sendIMessage(
  to: string,
  message: string,
  options?: IMessageOptions,
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

  const recipientError = checkRecipients(
    [to],
    options?.allowList ?? [],
    options?.blockList ?? [],
  );
  if (recipientError) throw new Error(recipientError);

  try {
    // No "-" before the arguments: osascript passes a bare "-" through as
    // argv item 1 and shifts every real argument by one. Same as appleNotes.ts.
    await execFileAsync("osascript", ["-e", SEND_SCRIPT, to, message]);
    return { sent: true };
  } catch (error: unknown) {
    // Report stderr only, which carries the actionable detail. The raw error
    // also carries the full argv, and that now includes the recipient and the
    // message body, which should not end up in a thrown message.
    const err = error as { stderr?: string; code?: number };
    const detail = err.stderr?.trim() || `exit code ${err.code ?? "unknown"}`;
    throw new Error(`Failed to send iMessage: ${detail}`);
  }
}
