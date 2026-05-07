import fs from "fs/promises";
import os from "os";
import path from "path";
import process from "process";
import diff_match_patch from "diff-match-patch";

export type EditResult = {
  replacements: number;
  path: string;
};

export async function resolvePath(dir: string, filename: string): Promise<string> {
  if (!dir) {
    throw new Error(`dir must not be empty. Use "." for the current directory.`);
  }
  if (path.isAbsolute(filename)) {
    throw new Error(`Filename must not be absolute when dir is specified (got "${filename}").`);
  }
  const baseDir = path.resolve(process.cwd(), dir);
  const full = path.resolve(baseDir, filename);
  // Lexical check first (catches .. before the file exists)
  if (!full.startsWith(baseDir + path.sep) && full !== baseDir) {
    throw new Error(`Filename "${filename}" escapes directory "${dir}".`);
  }
  // Resolve symlinks and recheck to prevent symlink-based escapes
  let realFull: string;
  try {
    realFull = await fs.realpath(full);
  } catch {
    // File doesn't exist yet (e.g. write) — lexical check is sufficient
    return full;
  }
  let realBase: string;
  try {
    realBase = await fs.realpath(baseDir);
  } catch {
    realBase = baseDir;
  }
  if (!realFull.startsWith(realBase + path.sep) && realFull !== realBase) {
    throw new Error(`Filename "${filename}" resolves outside directory "${dir}" via symlink.`);
  }
  return full;
}

export async function _edit(
  dir: string,
  filename: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): Promise<EditResult> {
  if (oldText.length === 0) {
    throw new Error("edit: oldText must not be empty");
  }
  const full = await resolvePath(dir, filename);
  const before = await fs.readFile(full, "utf8");

  if (replaceAll) {
    if (before.indexOf(oldText) === -1) {
      throw new Error(`edit: oldText not found in ${filename}.`);
    }
    let count = 0;
    const after = before.replaceAll(oldText, () => {
      count++;
      return newText;
    });
    await fs.writeFile(full, after, "utf8");
    return { replacements: count, path: filename };
  }

  const first = before.indexOf(oldText);
  if (first === -1) {
    throw new Error(
      `edit: oldText not found in ${filename}. The text to replace must appear exactly once (or use replaceAll=true).`,
    );
  }
  const second = before.indexOf(oldText, first + oldText.length);
  if (second !== -1) {
    throw new Error(
      `edit: oldText appears multiple times in ${filename}. Provide more surrounding context to make it unique, or set replaceAll=true.`,
    );
  }
  const after =
    before.slice(0, first) + newText + before.slice(first + oldText.length);
  await fs.writeFile(full, after, "utf8");
  return { replacements: 1, path: filename };
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

export async function _multiedit(
  dir: string,
  filename: string,
  edits: MultiEdit[],
): Promise<MultiEditResult> {
  const full = await resolvePath(dir, filename);
  let contents = await fs.readFile(full, "utf8");
  let total = 0;

  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText, replaceAll } = edits[i];
    if (!oldText) {
      throw new Error(`multiedit: edit #${i + 1} has empty oldText`);
    }
    if (replaceAll) {
      if (contents.indexOf(oldText) === -1) {
        throw new Error(
          `multiedit: edit #${i + 1} oldText not found in ${filename}`,
        );
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
        throw new Error(
          `multiedit: edit #${i + 1} oldText not found in ${filename}`,
        );
      }
      const second = contents.indexOf(oldText, first + oldText.length);
      if (second !== -1) {
        throw new Error(
          `multiedit: edit #${i + 1} oldText appears multiple times in ${filename}. Provide more context or set replaceAll.`,
        );
      }
      contents =
        contents.slice(0, first) +
        newText +
        contents.slice(first + oldText.length);
      total += 1;
    }
  }

  await fs.writeFile(full, contents, "utf8");
  return { replacements: total, path: filename, edits: edits.length };
}

export type PatchResult = {
  applied: number;
  files: string[];
};

export async function _applyPatch(patch: string): Promise<PatchResult> {
  const files = parseUnifiedDiff(patch);
  const touched: string[] = [];

  for (const f of files) {
    const full = path.resolve(process.cwd(), f.path);
    let original = "";
    if (f.isNew) {
      original = "";
    } else {
      original = await fs.readFile(full, "utf8");
    }
    const updated = applyHunks(original, f.hunks, f.path);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, updated, "utf8");
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
    allPatches.push(
      ...dmp.patch_make(before.join("\n"), after.join("\n")),
    );
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

export async function _mkdir(dir: string): Promise<void> {
  const full = path.resolve(process.cwd(), dir);
  await fs.mkdir(full, { recursive: true });
}

export async function _copy(src: string, dest: string): Promise<void> {
  const srcFull = path.resolve(process.cwd(), src);
  const destFull = path.resolve(process.cwd(), dest);
  await fs.cp(srcFull, destFull, { recursive: true });
}

export async function _move(src: string, dest: string): Promise<void> {
  await rejectDangerousPath(src, "move", "source");
  const srcFull = path.resolve(process.cwd(), src);
  const destFull = path.resolve(process.cwd(), dest);
  try {
    await fs.rename(srcFull, destFull);
  } catch (e: any) {
    if (e?.code === "EXDEV") {
      await fs.cp(srcFull, destFull, { recursive: true });
      await fs.rm(srcFull, { recursive: true, force: true });
      return;
    }
    throw e;
  }
}

export async function _remove(target: string): Promise<void> {
  await rejectDangerousPath(target, "remove", "target");
  const full = path.resolve(process.cwd(), target);
  await fs.rm(full, { recursive: true, force: true });
}

export async function rejectDangerousPath(
  p: string,
  op: string,
  role: string,
): Promise<void> {
  const trimmed = p.trim();
  if (trimmed === "") {
    throw new Error(`${op}: ${role} must not be empty`);
  }
  const lexical = path.resolve(process.cwd(), trimmed);
  const [real, homeReal, cwdReal] = await Promise.all([
    realpathOrResolve(lexical),
    realpathOrResolve(os.homedir()),
    realpathOrResolve(process.cwd()),
  ]);

  for (const candidate of new Set([lexical, real])) {
    const root = path.parse(candidate).root;

    if (samePath(candidate, root)) {
      throw new Error(
        `${op}: refusing to use the filesystem root as ${role} (got '${p}')`,
      );
    }

    if (homeReal && samePath(candidate, homeReal)) {
      throw new Error(
        `${op}: refusing to use the home directory as ${role} (got '${p}')`,
      );
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

    if (
      samePath(cwdReal, candidate) ||
      cwdStartsWith(cwdReal, candidate + path.sep)
    ) {
      throw new Error(
        `${op}: refusing to use the current working directory or one of its ancestors '${candidate}' as ${role} (got '${p}')`,
      );
    }
  }
}

async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
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
