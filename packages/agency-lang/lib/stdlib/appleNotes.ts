import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Our own bound on the wait. Without it, AppleScript's 120-second default
 *  applies, which is indistinguishable from a hang for an agent tool call.
 *  A spike confirmed `with timeout` does shorten the TCC consent wait. */
export const NOTES_TIMEOUT_SECONDS = 30;

/** Separator for multi-field script returns. Not a tab: note titles can
 *  legally contain tabs, and a title with one would corrupt the parse.
 *  Written as an escape, never a raw byte: a raw U+0001 is invisible in
 *  every editor and survives copy-paste unreliably. */
export const FIELD_DELIM = "\u0001";

/** Wrap an AppleScript body in the argv handler and our own timeout. */
export function withTimeout(body: string): string {
  return `on run argv
  with timeout of ${NOTES_TIMEOUT_SECONDS} seconds
${body}
  end timeout
end run`;
}

/** Run an AppleScript against Notes, passing data as argv.
 *
 *  Data NEVER goes into the script source. Titles and bodies are
 *  model-authored, and the model may have been influenced by a page it read,
 *  so interpolating them would be an injection path. argv values are not
 *  parsed as AppleScript. */
export async function runNotesScript(script: string, args: string[]): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("Apple Notes is only available on macOS.");
  }

  try {
    // No "-" before args: osascript passes it through as argv item 1 and
    // shifts every real argument by one.
    const { stdout } = await execFileAsync("osascript", ["-e", script, ...args]);
    return stdout.trim();
  } catch (error: unknown) {
    const err = error as { stderr?: string; code?: number };
    const stderr = err.stderr?.trim() ?? "";

    // -1743 is unambiguous: no grant, or it was denied, and no dialog pending.
    if (stderr.includes("-1743")) {
      throw new Error(
        "Not authorized to control Notes. Grant permission in " +
          "System Settings → Privacy & Security → Automation.",
      );
    }

    // -1712 is ambiguous: it covers an unanswered consent dialog, a busy
    // Notes, and a wedged Notes. The message hedges on purpose — claiming
    // otherwise sends people to fix a permission that was never the problem.
    if (stderr.includes("-1712")) {
      throw new Error(
        `Notes did not respond within ${NOTES_TIMEOUT_SECONDS}s. This usually ` +
          "means macOS automation permission was not granted. Check " +
          "System Settings → Privacy & Security → Automation.",
      );
    }

    throw new Error(`Notes command failed: ${stderr || `exit code ${err.code ?? "unknown"}`}`);
  }
}
