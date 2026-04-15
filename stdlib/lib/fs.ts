import fs from "fs";
import path from "path";
import process from "process";

export type EditResult = {
  replacements: number;
  path: string;
};

export function _edit(
  filename: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): EditResult {
  if (oldText.length === 0) {
    throw new Error("edit: oldText must not be empty");
  }
  const full = path.resolve(process.cwd(), filename);
  const before = fs.readFileSync(full, "utf8");

  if (replaceAll) {
    const pieces = before.split(oldText);
    if (pieces.length === 1) {
      throw new Error(`edit: oldText not found in ${filename}.`);
    }
    fs.writeFileSync(full, pieces.join(newText), "utf8");
    return { replacements: pieces.length - 1, path: filename };
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
  fs.writeFileSync(full, after, "utf8");
  return { replacements: 1, path: filename };
}

export type MultiEdit = {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
};

export type MultiEditResult = {
  replacements: number;
  path: string;
  edits: number;
};

export function _multiedit(
  filename: string,
  edits: MultiEdit[],
): MultiEditResult {
  const full = path.resolve(process.cwd(), filename);
  let contents = fs.readFileSync(full, "utf8");
  let total = 0;

  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText, replaceAll } = edits[i];
    if (!oldText) {
      throw new Error(`multiedit: edit #${i + 1} has empty oldText`);
    }
    if (replaceAll) {
      const pieces = contents.split(oldText);
      if (pieces.length === 1) {
        throw new Error(
          `multiedit: edit #${i + 1} oldText not found in ${filename}`,
        );
      }
      contents = pieces.join(newText);
      total += pieces.length - 1;
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

  fs.writeFileSync(full, contents, "utf8");
  return { replacements: total, path: filename, edits: edits.length };
}

export type PatchResult = {
  applied: number;
  files: string[];
};

export function _applyPatch(patch: string): PatchResult {
  const files = parseUnifiedDiff(patch);
  const touched: string[] = [];

  for (const f of files) {
    const full = path.resolve(process.cwd(), f.path);
    let original = "";
    if (f.isNew) {
      original = "";
    } else {
      original = fs.readFileSync(full, "utf8");
    }
    const updated = applyHunks(original, f.hunks, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, updated, "utf8");
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
      const newFile = nextLine.slice(4).trim();
      const oldFile = line.slice(4).trim();
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

function applyHunks(original: string, hunks: Hunk[], filePath: string): string {
  const origLines = original === "" ? [] : original.split("\n");
  const hadTrailingNewline = original.endsWith("\n");
  const out: string[] = [];
  let cursor = 0;

  for (const h of hunks) {
    const targetStart = h.oldStart - 1;
    while (cursor < targetStart) {
      out.push(origLines[cursor]);
      cursor++;
    }
    for (const hl of h.lines) {
      const tag = hl[0];
      const content = hl.slice(1);
      if (tag === " ") {
        if (origLines[cursor] !== content) {
          throw new Error(
            `applyPatch: context mismatch in ${filePath} at line ${cursor + 1}. Expected "${content}", got "${origLines[cursor] ?? ""}"`,
          );
        }
        out.push(content);
        cursor++;
      } else if (tag === "-") {
        if (origLines[cursor] !== content) {
          throw new Error(
            `applyPatch: cannot remove line in ${filePath} at line ${cursor + 1}. Expected "${content}", got "${origLines[cursor] ?? ""}"`,
          );
        }
        cursor++;
      } else if (tag === "+") {
        out.push(content);
      }
    }
  }
  while (cursor < origLines.length) {
    out.push(origLines[cursor]);
    cursor++;
  }

  let result = out.join("\n");
  if (hadTrailingNewline && !result.endsWith("\n")) result += "\n";
  return result;
}
