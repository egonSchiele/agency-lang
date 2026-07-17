import { execFile } from "child_process";
import { promisify } from "util";
import renderWithTimeout from "../templates/applescript/notes/withTimeout.js";
import renderAccountWalk from "../templates/applescript/notes/accountWalk.js";
import renderPreflight from "../templates/applescript/notes/preflight.js";
import renderReadUnscoped from "../templates/applescript/notes/readUnscoped.js";
import renderReadScoped from "../templates/applescript/notes/readScoped.js";
import renderNoteRow from "../templates/applescript/notes/noteRow.js";
import renderListAll from "../templates/applescript/notes/listAll.js";
import renderListInFolder from "../templates/applescript/notes/listInFolder.js";
import renderSearchAll from "../templates/applescript/notes/searchAll.js";
import renderSearchInFolder from "../templates/applescript/notes/searchInFolder.js";
import renderListFolders from "../templates/applescript/notes/listFolders.js";
import renderFolderExists from "../templates/applescript/notes/folderExists.js";
import renderCreate from "../templates/applescript/notes/create.js";
import renderAppendBody from "../templates/applescript/notes/appendBody.js";
import renderAppendScoped from "../templates/applescript/notes/appendScoped.js";
import renderAppendUnscoped from "../templates/applescript/notes/appendUnscoped.js";
import renderDeleteScoped from "../templates/applescript/notes/deleteScoped.js";
import renderDeleteUnscoped from "../templates/applescript/notes/deleteUnscoped.js";

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

/** Wrap an AppleScript body in the argv handler and our own timeout.
 *
 *  The AppleScript sources live as typestache templates in
 *  lib/templates/applescript/notes/. Edit the .mustache files and run
 *  `pnpm run templates`; never edit the generated .ts files. */
export function withTimeout(body: string): string {
  return renderWithTimeout({ timeoutSeconds: NOTES_TIMEOUT_SECONDS, body });
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
    // trimEnd, not trim: osascript appends a trailing newline, but leading
    // whitespace is meaningful in note plaintext (indented code, for one) and
    // the plaintext is the first field of a read reply. Same as keyring.ts.
    return stdout.trimEnd();
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
export const ACCOUNT_WALK = renderAccountWalk({});

// The preflight template splits `set c to container of n` on purpose.
// `name of container of n` in one expression errors -1728 on EVERY note,
// locked or unlocked. The property is fine; chaining a read through it is
// not. Spec section 9.2.
const PREFLIGHT_SCRIPT = withTimeout(renderPreflight({ accountWalk: ACCOUNT_WALK }));

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
export function assertNotLocked(meta: NotePreflight): void {
  if (meta.locked) {
    throw new Error(`Note "${meta.title}" is locked. Unlock it in Notes.app and retry.`);
  }
}

/** Note metadata. Deliberately carries no body. */
export type NoteMeta = {
  id: string;
  title: string;
  folder: string;
  account: string;
  modified: string;
  passwordProtected: boolean;
};

/** A note including its content, as plaintext. */
export type NoteContentTs = {
  id: string;
  title: string;
  folder: string;
  account: string;
  body: string;
  modified: string;
};

/** A folder. `noteCount` is derived, not a property. */
export type FolderMeta = {
  id: string;
  name: string;
  noteCount: number;
};

/** Assert a note is in the folder the caller named. Fails closed.
 *
 *  This compare is the fail-fast check with the readable error message. It is
 *  NOT the authoritative assertion: on both the read and write paths the
 *  actual access addresses the note THROUGH the folder (`note id X of folder
 *  Y`), so the lookup failing is the assertion failing, and the check cannot
 *  drift from the access across the human approval that sits between the
 *  pre-flight and the access. */
function assertFolder(meta: NotePreflight, folder?: string): void {
  if (folder != null && meta.folder !== folder) {
    throw new Error(
      `Note "${meta.title}" is in folder "${meta.folder}", not "${folder}". Refusing.`,
    );
  }
}

// Reads `plaintext`, never `body`. body is HTML: it would waste tokens and read
// badly for a model. Spec section 2.4.
//
// Two shapes, like the write path (spec section 6.4): when the caller asserted
// a folder, the read addresses the note THROUGH it, so a note that moved
// folders during the human approval fails to resolve instead of being read.
// An unscoped read would leave open on the read path the exact window the
// write path closes — and reading is the operation folder confinement was
// invented for.
const READ_UNSCOPED_SCRIPT = withTimeout(renderReadUnscoped({}));
const READ_SCOPED_SCRIPT = withTimeout(renderReadScoped({}));

export async function _readNote(id: string, folder?: string): Promise<NoteContentTs> {
  const meta = await _preflightNote(id);
  assertFolder(meta, folder);
  assertNotLocked(meta);

  const raw = folder == null
    ? await runNotesScript(READ_UNSCOPED_SCRIPT, [id])
    : await runNotesScript(READ_SCOPED_SCRIPT, [id, folder]);
  const parts = raw.split(FIELD_DELIM);
  if (parts.length !== 2) {
    throw new Error(`Notes returned an unexpected reply for note ${id}.`);
  }
  return {
    id,
    title: meta.title,
    folder: meta.folder,
    account: meta.account,
    body: parts[0],
    modified: parts[1],
  };
}

/** Parse the delimited note rows a list/search script returns. */
function parseNoteRows(raw: string): NoteMeta[] {
  const rows = raw.split("\n").filter((line) => line.length > 0);
  return rows.map((line) => {
    const fields = line.split(FIELD_DELIM);
    if (fields.length !== 6) {
      throw new Error("Notes returned an unexpected row while listing notes.");
    }
    return {
      id: fields[0],
      title: fields[1],
      folder: fields[2],
      account: fields[3],
      modified: fields[4],
      passwordProtected: fields[5].trim() === "true",
    };
  });
}

// The container access is split here too (spec 9.2), and the account is walked
// rather than assumed to be one hop up.
const NOTE_ROW = renderNoteRow({ accountWalk: ACCOUNT_WALK });

const LIST_ALL_SCRIPT = withTimeout(renderListAll({ noteRow: NOTE_ROW }));
const LIST_IN_FOLDER_SCRIPT = withTimeout(renderListInFolder({ noteRow: NOTE_ROW }));

export async function _listNotes(folder?: string): Promise<NoteMeta[]> {
  const raw = folder == null
    ? await runNotesScript(LIST_ALL_SCRIPT, [])
    : await runNotesScript(LIST_IN_FOLDER_SCRIPT, [folder]);
  return parseNoteRows(raw);
}

// `plaintext contains`, never `body contains`. body is HTML, so searching it
// matches markup: a user searching "div" would match every note they own.
// Spec section 9.3.
const SEARCH_ALL_SCRIPT = withTimeout(renderSearchAll({ noteRow: NOTE_ROW }));
const SEARCH_IN_FOLDER_SCRIPT = withTimeout(renderSearchInFolder({ noteRow: NOTE_ROW }));

export async function _searchNotes(query: string, folder?: string): Promise<NoteMeta[]> {
  const raw = folder == null
    ? await runNotesScript(SEARCH_ALL_SCRIPT, [query])
    : await runNotesScript(SEARCH_IN_FOLDER_SCRIPT, [query, folder]);
  return parseNoteRows(raw);
}

// TOP-LEVEL FOLDERS ONLY, on purpose.
//
// A bare `repeat with f in folders` FLATTENS the hierarchy: on a machine with
// an "Archived" folder containing "2010s", "2017" and "2019", it returns all
// four side by side with nothing marking the difference. Reporting "2017" as a
// peer of "Recently Deleted" is simply false, and an agent would act on it.
//
// So filter to folders whose container is an account. That is honest and
// limited rather than flat and wrong. Nested folders stay reachable by bare
// name (`folder "2017"` does resolve), ambiguously — which is Notes' own
// behaviour, not something we introduce. Path support is out of scope for v1;
// see the plan's "Two v1 limits".
//
// noteCount is derived with `count of notes`, because folder has no such
// property. That is a query per folder, so listFolders pays for it.
const LIST_FOLDERS_SCRIPT = withTimeout(renderListFolders({}));

export async function _listFolders(): Promise<FolderMeta[]> {
  const raw = await runNotesScript(LIST_FOLDERS_SCRIPT, []);
  const rows = raw.split("\n").filter((line) => line.length > 0);
  return rows.map((line) => {
    const fields = line.split(FIELD_DELIM);
    if (fields.length !== 3) {
      throw new Error("Notes returned an unexpected row while listing folders.");
    }
    const noteCount = Number(fields[2]);
    if (!Number.isFinite(noteCount)) {
      throw new Error("Notes returned a non-numeric note count while listing folders.");
    }
    return { id: fields[0], name: fields[1], noteCount };
  });
}

const FOLDER_EXISTS_SCRIPT = withTimeout(renderFolderExists({}));

export async function _folderExists(folder: string): Promise<boolean> {
  const raw = await runNotesScript(FOLDER_EXISTS_SCRIPT, [folder]);
  return raw.trim() === "true";
}

// "Agency Notes" is our own default and will not exist on a fresh machine, so
// create it on demand. Spec section 9.4. The interrupt payload carries
// folderCreated so a human or policy sees the folder being made.
const CREATE_SCRIPT = withTimeout(renderCreate({ accountWalk: ACCOUNT_WALK }));

/** Create a note. `html` is HTML, already rendered — this layer does not know
 *  about markdown. The Agency module does the conversion. */
export async function _createNote(
  title: string,
  html: string,
  folder: string,
): Promise<NoteMeta> {
  const raw = await runNotesScript(CREATE_SCRIPT, [title, html, folder]);
  const rows = parseNoteRows(raw);
  if (rows.length !== 1) {
    throw new Error("Notes returned an unexpected reply while creating a note.");
  }
  return rows[0];
}

// Two shapes: scoped and unscoped. The scoped one addresses the note THROUGH
// the folder, so the lookup failing IS the assertion failing. That is stronger
// than read-then-compare, because the reference that gets mutated is the same
// one that had to resolve inside the asserted folder — the check cannot drift
// from the access across the human approval that precedes this. Spec 6.4.
const APPEND_BODY = renderAppendBody({ accountWalk: ACCOUNT_WALK });

const APPEND_SCOPED_SCRIPT = withTimeout(renderAppendScoped({ appendBody: APPEND_BODY }));
const APPEND_UNSCOPED_SCRIPT = withTimeout(renderAppendUnscoped({ appendBody: APPEND_BODY }));

/** Append to a note. `html` is HTML, already rendered.
 *
 *  The Agency layer already refused locked notes before its interrupt was
 *  approved. This layer still re-runs the pre-flight, and the write script
 *  checks `password protected` once more, because a human approval sits
 *  between that first check and this call, and the note can be locked in that
 *  window. Spec section 2.7 explains why a missed check destroys data.
 *
 *  The interrupt payload the approver saw reflects the pre-approval
 *  pre-flight. This second pre-flight is the authoritative one for the
 *  write. */
export async function _appendToNote(
  id: string,
  html: string,
  folder?: string,
): Promise<NoteMeta> {
  const meta = await _preflightNote(id);
  assertFolder(meta, folder);
  assertNotLocked(meta);

  const raw = folder == null
    ? await runNotesScript(APPEND_UNSCOPED_SCRIPT, [id, html])
    : await runNotesScript(APPEND_SCOPED_SCRIPT, [id, html, folder]);

  const rows = parseNoteRows(raw);
  if (rows.length !== 1) {
    throw new Error(`Notes returned an unexpected reply while appending to note ${id}.`);
  }
  return rows[0];
}

const DELETE_SCOPED_SCRIPT = withTimeout(renderDeleteScoped({}));
const DELETE_UNSCOPED_SCRIPT = withTimeout(renderDeleteUnscoped({}));

/** Delete a note. It moves to Recently Deleted, where it stays ~30 days. */
export async function _deleteNote(id: string, folder?: string): Promise<null> {
  const meta = await _preflightNote(id);
  assertFolder(meta, folder);
  assertNotLocked(meta);

  if (folder == null) {
    await runNotesScript(DELETE_UNSCOPED_SCRIPT, [id]);
  } else {
    await runNotesScript(DELETE_SCOPED_SCRIPT, [id, folder]);
  }
  return null;
}
