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

/** A note's metadata, read before the interrupt so the payload can carry it. */
export type NotePreflight = {
  id: string;
  title: string;
  folder: string;
  account: string;
  locked: boolean;
};

/** Walk from a folder (`c`) up to its account, leaving it in `a`.
 *
 *  A folder's container is its PARENT FOLDER when nested, not the account.
 *  Measured: `container of folder "2017"` is `Archived`, not `iCloud`. One hop
 *  up is wrong for any nested folder, and wrong silently — the account field
 *  would hold a folder name and every {"account": "iCloud"} policy would quietly
 *  stop matching.
 *
 *  Bounded, and fails closed rather than returning a folder as an account.
 *  Verified to reach iCloud from Archived/2017 in 2 hops. */
export const ACCOUNT_WALK = `      set a to container of c
      set acctFound to false
      repeat 10 times
        if (class of a) is account then
          set acctFound to true
          exit repeat
        end if
        set a to container of a
      end repeat
      if not acctFound then error "Could not resolve the account for this note."`;

// `set c to container of n` is split on purpose. `name of container of n` in one
// expression errors -1728 on EVERY note, locked or unlocked. The property is
// fine; chaining a read through it is not. Spec section 9.2.
const PREFLIGHT_SCRIPT = withTimeout(`    tell application "Notes"
      set n to note id (item 1 of argv)
      set c to container of n
${ACCOUNT_WALK}
      set d to (ASCII character 1)
      return (name of n) & d & (name of c) & d & (name of a) & d & ¬
             ((password protected of n) as text)
    end tell`);

/** Read a note's metadata: title, folder, account, locked flag.
 *
 *  This query is NOT interrupt-gated, because the interrupt payload needs its
 *  results in order to exist. That is acceptable for a narrow reason worth
 *  keeping precise: a note id is unguessable. It is an opaque x-coredata://
 *  URI that cannot be enumerated or constructed, so anyone holding one already
 *  learned it somewhere, and this discloses only the title and folder that
 *  whoever handed them the id could already name.
 *
 *  It is NOT true that an id can only come from a gated call — ids are stable
 *  and can arrive from a user message, a file, or a restored checkpoint. Do not
 *  widen this query on the strength of that weaker claim. It reads three
 *  properties and no content, and it should stay that way. */
export async function _preflightNote(id: string): Promise<NotePreflight> {
  const raw = await runNotesScript(PREFLIGHT_SCRIPT, [id]);
  const parts = raw.split(FIELD_DELIM);
  if (parts.length !== 4) {
    throw new Error(`Notes returned an unexpected reply for note ${id}.`);
  }
  return {
    id,
    title: parts[0],
    folder: parts[1],
    account: parts[2],
    locked: parts[3].trim() === "true",
  };
}

/** Refuse a locked note.
 *
 *  This is DATA-LOSS PREVENTION, not a friendlier error. A locked note's body
 *  reads as an empty string rather than erroring, so an append that skipped
 *  this guard would run `set body of n to "" & newText` and replace the note's
 *  contents with the appended text. Spec section 2.7.
 *
 *  Never skip this, never reorder it after a body read, and never remove it as
 *  apparently-dead code. */
export function assertNotLocked(p: NotePreflight): void {
  if (p.locked) {
    throw new Error(`Note "${p.title}" is locked. Unlock it in Notes.app and retry.`);
  }
}
