import path from "#path";
import diff_match_patch from "diff-match-patch";
import type { Host, Located } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { assertContained } from "./assertContained.js";
import { WINDOWS_PATHS } from "./isContained.js";
import { expandPath } from "./expandPath.js";

export { prepareContainedPath as _prepareContainedPath } from "./prepareContainedPath.js";
export { resolveRedirectTarget as _resolveRedirectTarget } from "./prepareContainedPath.js";

/** The real spelling of a directory, for an interrupt payload. */
export async function _realDir(dir: string): Promise<string> {
  const host = currentHost();
  return host.files.realDir(dir);
}

/** The real spelling of a whole path, for an interrupt payload. */
export async function _realTarget(p: string): Promise<string> {
  const host = currentHost();
  return host.files.realPath(p);
}

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
  const host = currentHost();
  try {
    const before = await host.files.readText(await host.files.fixedRoot(rootDir), filename);
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
  const host = currentHost();
  const sandbox = await host.files.fixedRoot(rootDir);
  let replacements = 0;
  await host.files.updateText(sandbox, filename, (original) => {
    if (original === null) {
      throw new Error(`multiedit: no such file: ${filename}`);
    }
    const applied = applyEdits(original, edits, filename);
    replacements = applied.replacements;
    return applied.contents;
  });
  return { replacements, path: filename, edits: edits.length };
}

export type PatchResult = {
  applied: number;
  files: string[];
};

/** The real whole path of every file a patch touches, in patch order, for
 *  the `std::applyPatch` payload. Paths in the patch text are relative to
 *  the run's working directory. */
export async function _patchFiles(patch: string): Promise<string[]> {
  const host = currentHost();
  const files: string[] = [];
  for (const f of parseUnifiedDiff(patch)) {
    files.push(await host.files.realPath(f.path));
  }
  return files;
}

/** Apply a parsed patch. `approved` is the file list the approver saw, from
 *  `_patchFiles`; each entry is taken through `fixedPath`, so a link planted
 *  at one of those paths after approval is refused. Without it, as from a
 *  direct TypeScript caller, each path is resolved from the patch text. */
export async function _applyPatch(
  patch: string,
  allowedPaths?: string[],
  approved?: string[],
): Promise<PatchResult> {
  const host = currentHost();
  const files = parseUnifiedDiff(patch);
  if (approved !== undefined && approved.length !== files.length) {
    throw new Error(
      `applyPatch: the approved file list names ${approved.length} files but the patch touches ${files.length}`,
    );
  }
  const touched: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const spelled = approved === undefined ? f.path : approved[i];
    await assertContained(host, spelled, allowedPaths ?? [], host.system.cwd());
    const located =
      approved === undefined
        ? await host.files.wholePath(spelled)
        : await host.files.fixedPath(spelled);
    await host.files.mkdir(located.root, ".");
    if (f.isNew) {
      const updated = applyHunks("", f.hunks, f.path);
      await host.files.writeText(located.root, located.target, updated, { mode: "create-only" });
    } else {
      await host.files.updateText(located.root, located.target, (original) => {
        if (original === null) {
          throw new Error(`applyPatch: no such file: ${f.path}`);
        }
        return applyHunks(original, f.hunks, f.path);
      });
    }
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

/** A whole path the interrupt named, in the real spelling the approver
 *  saw, checked against the program's own allow-list and split into its
 *  parent and final name without following anything. */
async function locateWhole(
  host: Host,
  p: string,
  allowedPaths: string[] | undefined,
): Promise<Located> {
  await assertContained(host, p, allowedPaths ?? [], host.system.cwd());
  return host.files.fixedPath(p);
}

export async function _mkdir(dir: string, allowedPaths?: string[]): Promise<void> {
  const host = currentHost();
  const located = await locateWhole(host, dir, allowedPaths);
  await host.files.mkdir(located.root, located.target);
}

export async function _copy(src: string, dest: string, allowedPaths?: string[]): Promise<void> {
  const host = currentHost();
  const from = await locateWhole(host, src, allowedPaths);
  const to = await locateWhole(host, dest, allowedPaths);
  await host.files.copy(from, to);
}

export async function _move(src: string, dest: string, allowedPaths?: string[]): Promise<void> {
  const host = currentHost();
  const from = await locateWhole(host, src, allowedPaths);
  const to = await locateWhole(host, dest, allowedPaths);
  await rejectDangerousPath(host, src, "move", "source");
  await host.files.move(from, to);
}

export async function _remove(target: string, allowedPaths?: string[]): Promise<void> {
  const host = currentHost();
  const located = await locateWhole(host, target, allowedPaths);
  await rejectDangerousPath(host, target, "remove", "target");
  await host.files.remove(located.root, located.target);
}

export async function rejectDangerousPath(
  host: Host,
  p: string,
  op: string,
  role: string,
): Promise<void> {
  const trimmed = p.trim();
  if (trimmed === "") {
    throw new Error(`${op}: ${role} must not be empty`);
  }
  // Expand `~` first so the home / top-level checks below are
  // performed against the actual target, not the literal `~/foo`.
  const lexical = path.resolve(host.system.cwd(), expandPath(trimmed));
  const real = await host.files.realDir(lexical);
  const homeReal = await host.files.realDir(host.system.homeDir());
  const cwdReal = await host.files.realDir(host.system.cwd());

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
  if (WINDOWS_PATHS) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function cwdStartsWith(cwd: string, prefix: string): boolean {
  if (WINDOWS_PATHS) {
    return cwd.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return cwd.startsWith(prefix);
}
