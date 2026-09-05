import os from "os";
import path from "path";
import process from "process";
import diff_match_patch from "diff-match-patch";
import { assertContained } from "./assertContained.js";
import { expandPath } from "./expandPath.js";
import {
  root,
  wholePath,
  readText,
  writeText,
  mkdir,
  remove,
  copy,
  move,
  type Located,
} from "./contained.js";

export { prepareContainedPath as _prepareContainedPath } from "./prepareContainedPath.js";
export { resolveRedirectTarget as _resolveRedirectTarget } from "./prepareContainedPath.js";
export { _realDir, _realTarget } from "./contained.js";

export type MultiEdit = {
  oldText: string;
  newText: string;
  replaceAll: boolean;
};

export type MultiEditResult = {
  replacements: number;
  path: string;
  edits: number;
};

// Apply the edits to `contents` in memory (no I/O), returning the result and
// the number of replacements. Throws on a missing or ambiguous match. Shared
// by `_multiedit` (which writes) and `_previewEdit` (which doesn't).
function applyEdits(
  contents: string,
  edits: MultiEdit[],
  filename: string,
): { contents: string; replacements: number } {
  let total = 0;
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText, replaceAll } = edits[i];
    if (!oldText) {
      throw new Error(`multiedit: edit #${i + 1} has empty oldText`);
    }
    if (replaceAll) {
      if (contents.indexOf(oldText) === -1) {
        throw new Error(`multiedit: edit #${i + 1} oldText not found in ${filename}`);
      }
      let count = 0;
      contents = contents.replaceAll(oldText, () => {
        count++;
        return newText;
      });
      total += count;
    } else {
      const first = contents.indexOf(oldText);
      if (first === -1) {
        throw new Error(`multiedit: edit #${i + 1} oldText not found in ${filename}`);
      }
      const second = contents.indexOf(oldText, first + oldText.length);
      if (second !== -1) {
        throw new Error(
          `multiedit: edit #${i + 1} oldText appears multiple times in ${filename}. Provide more context or set replaceAll.`,
        );
      }
      contents = contents.slice(0, first) + newText + contents.slice(first + oldText.length);
      total += 1;
    }
  }
  return { contents, replacements: total };
}

// Compute the before/after contents of an edit without writing. Used to put a
// preview in the `std::edit` interrupt data so handlers can diff it themselves.
// Best-effort: a bad path, missing file, or non-matching edit returns empty
// strings rather than throwing, so the interrupt still fires (and can be
// rejected). The authoritative validation and erroring happen in `_multiedit`
// after the interrupt is approved.
export async function _previewEdit(
  rootDir: string,
  filename: string,
  edits: MultiEdit[],
): Promise<{ before: string; after: string }> {
  try {
    const before = readText(root(rootDir), filename);
    const { contents } = applyEdits(before, edits, filename);
    return { before, after: contents };
  } catch {
    return { before: "", after: "" };
  }
}

export async function _multiedit(
  rootDir: string,
  filename: string,
  edits: MultiEdit[],
): Promise<MultiEditResult> {
  const sandbox = root(rootDir);
  const original = readText(sandbox, filename);
  const { contents, replacements } = applyEdits(original, edits, filename);
  writeText(sandbox, filename, contents);
  return { replacements, path: filename, edits: edits.length };
}

export type PatchResult = {
  applied: number;
  files: string[];
};

export async function _applyPatch(patch: string, allowedPaths?: string[]): Promise<PatchResult> {
  const files = parseUnifiedDiff(patch);
  const touched: string[] = [];

  for (const f of files) {
    // A patched file is a whole path relative to the process cwd.
    const located = await locateWhole(f.path, allowedPaths);
    const original = f.isNew ? "" : readText(located.root, located.target);
    const updated = applyHunks(original, f.hunks, f.path);
    mkdir(located.root, ".");
    writeText(located.root, located.target, updated, {
      mode: f.isNew ? "create-only" : "overwrite",
    });
    touched.push(f.path);
  }

  return { applied: files.length, files: touched };
}

type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

type DiffFile = {
  path: string;
  isNew: boolean;
  hunks: Hunk[];
};

function parseUnifiedDiff(patch: string): DiffFile[] {
  const lines = patch.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: Hunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("--- ")) {
      if (current) files.push(current);
      const nextLine = lines[i + 1] || "";
      if (!nextLine.startsWith("+++ ")) {
        throw new Error("applyPatch: malformed diff, missing +++ after ---");
      }
      const newFile = firstToken(nextLine.slice(4));
      const oldFile = firstToken(line.slice(4));
      const target = stripPathPrefix(newFile === "/dev/null" ? oldFile : newFile);
      current = {
        path: target,
        isNew: oldFile === "/dev/null" || oldFile.endsWith("/dev/null"),
        hunks: [],
      };
      hunk = null;
      i++;
    } else if (line.startsWith("@@")) {
      if (!current) throw new Error("applyPatch: hunk before file header");
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) throw new Error(`applyPatch: malformed hunk header: ${line}`);
      hunk = {
        oldStart: parseInt(m[1], 10),
        oldLines: m[2] ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newLines: m[4] ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      current.hunks.push(hunk);
    } else if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      hunk.lines.push(line);
    }
  }
  if (current) files.push(current);
  return files;
}

function stripPathPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function firstToken(s: string): string {
  const m = s.match(/^\S+/);
  return m ? m[0] : "";
}

function applyHunks(original: string, hunks: Hunk[], filePath: string): string {
  const dmp = new diff_match_patch();
  const allPatches: Array<typeof diff_match_patch.patch_obj> = [];

  for (const h of hunks) {
    const before: string[] = [];
    const after: string[] = [];
    for (const line of h.lines) {
      const tag = line[0];
      const content = line.slice(1);
      if (tag === " ") {
        before.push(content);
        after.push(content);
      } else if (tag === "-") {
        before.push(content);
      } else if (tag === "+") {
        after.push(content);
      }
    }
    allPatches.push(...dmp.patch_make(before.join("\n"), after.join("\n")));
  }

  const [updated, applied] = dmp.patch_apply(allPatches, original);
  const firstFailed = applied.findIndex((ok) => !ok);
  if (firstFailed !== -1) {
    throw new Error(
      `applyPatch: hunk #${firstFailed + 1} could not be applied to ${filePath}; the surrounding context does not match the current file contents`,
    );
  }
  return updated;
}

/** A whole path the interrupt named, checked against the program's own
 *  allow-list and split into its real parent and final name. */
async function locateWhole(p: string, allowedPaths: string[] | undefined): Promise<Located> {
  await assertContained(p, allowedPaths ?? [], process.cwd());
  return wholePath(p);
}

export async function _mkdir(dir: string, allowedPaths?: string[]): Promise<void> {
  const located = await locateWhole(dir, allowedPaths);
  mkdir(located.root, located.target);
}

export async function _copy(src: string, dest: string, allowedPaths?: string[]): Promise<void> {
  copy(await locateWhole(src, allowedPaths), await locateWhole(dest, allowedPaths));
}

export async function _move(src: string, dest: string, allowedPaths?: string[]): Promise<void> {
  const from = await locateWhole(src, allowedPaths);
  const to = await locateWhole(dest, allowedPaths);
  await rejectDangerousPath(src, "move", "source");
  move(from, to);
}

export async function _remove(target: string, allowedPaths?: string[]): Promise<void> {
  const located = await locateWhole(target, allowedPaths);
  await rejectDangerousPath(target, "remove", "target");
  remove(located.root, located.target);
}

export async function rejectDangerousPath(p: string, op: string, role: string): Promise<void> {
  const trimmed = p.trim();
  if (trimmed === "") {
    throw new Error(`${op}: ${role} must not be empty`);
  }
  // Expand `~` first so the home / top-level checks below are
  // performed against the actual target, not the literal `~/foo`.
  const lexical = path.resolve(process.cwd(), expandPath(trimmed));
  const real = root(lexical).real;
  const homeReal = root(os.homedir()).real;
  const cwdReal = root(process.cwd()).real;

  const candidates = [lexical, real].filter((c, i, all) => all.indexOf(c) === i);
  for (const candidate of candidates) {
    const root = path.parse(candidate).root;

    if (samePath(candidate, root)) {
      throw new Error(`${op}: refusing to use the filesystem root as ${role} (got '${p}')`);
    }

    if (homeReal && samePath(candidate, homeReal)) {
      throw new Error(`${op}: refusing to use the home directory as ${role} (got '${p}')`);
    }

    const segments = candidate
      .slice(root.length)
      .split(path.sep)
      .filter((s) => s.length > 0);
    if (segments.length <= 1) {
      throw new Error(
        `${op}: refusing to use the top-level path '${candidate}' as ${role} (got '${p}'); operations on a single segment under root could destroy critical system directories`,
      );
    }

    if (samePath(cwdReal, candidate) || cwdStartsWith(cwdReal, candidate + path.sep)) {
      throw new Error(
        `${op}: refusing to use the current working directory or one of its ancestors '${candidate}' as ${role} (got '${p}')`,
      );
    }
  }
}

function samePath(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function cwdStartsWith(cwd: string, prefix: string): boolean {
  if (process.platform === "win32") {
    return cwd.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return cwd.startsWith(prefix);
}
