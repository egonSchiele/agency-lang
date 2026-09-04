// The spill directory: where tool output too long to hand to the model is
// kept, and the two ways it comes back out. One fixed place, outside every
// project, so the write goes somewhere the model never chose and nothing
// lands in a repository.
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { _read } from "./builtins.js";
import { compileGrepQuery } from "./grepQuery.js";
import { firstMatchingLines, type GrepMatch } from "./shell.js";

/** `~/.agency-agent/tool-output`, or `AGENCY_TOOL_OUTPUT_DIR` when set, so a
 * test can point the spill somewhere it may delete. */
export function _spillDir(): string {
  const override = process.env.AGENCY_TOOL_OUTPUT_DIR;
  if (override !== undefined && override !== "") return override;
  return path.join(os.homedir(), ".agency-agent", "tool-output");
}

// A saved file's name: a timestamp, a random suffix, `.log`. The read
// tools accept only names of this shape, which rules out a slash, a `..`,
// and a leading dot, so no path can reach them.
const SPILL_NAME = /^[0-9A-Za-z][0-9A-Za-z_-]*\.log$/;

export function _spillName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomBytes(3).toString("hex")}.log`;
}

function checkName(filename: string): void {
  if (!SPILL_NAME.test(filename)) {
    throw new Error(
      `'${filename}' is not a saved output file name: expected one file name ending in .log, with no directory part`,
    );
  }
}

/** Write `text` under the spill directory as `filename`, creating the
 * directory if needed. The file is created fresh: an existing file is never
 * overwritten, even on a clock collision. */
export async function _spillOutput(filename: string, text: string): Promise<string> {
  checkName(filename);
  const dir = _spillDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), text, { flag: "wx", mode: 0o600 });
  return path.join(dir, filename);
}

/** The saved file, whole or a slice of lines; the same offset and limit
 * rules as `read`. */
export async function _readSpill(filename: string, offset: number, limit: number): Promise<string> {
  checkName(filename);
  return _read(_spillDir(), filename, offset, limit);
}

/** Lines matching `pattern` in one saved file, or in every saved file when
 * `filename` is empty. */
export async function _grepSpill(
  pattern: string,
  filename: string,
  maxResults: number,
): Promise<GrepMatch[]> {
  const plan = compileGrepQuery({
    pattern,
    flags: "",
    ignoreCase: false,
    wholeWord: false,
    filesOnly: false,
    invert: false,
  });
  const dir = _spillDir();
  let names: string[];
  if (filename === "") {
    try {
      names = (await readdir(dir)).filter((name) => SPILL_NAME.test(name)).sort();
    } catch {
      names = [];
    }
  } else {
    checkName(filename);
    names = [filename];
  }
  const matches: GrepMatch[] = [];
  for (const name of names) {
    if (matches.length >= maxResults) break;
    const text = await readFile(path.join(dir, name), "utf8");
    for (const hit of firstMatchingLines(text, plan, maxResults - matches.length)) {
      matches.push({ file: name, ...hit });
    }
  }
  return matches;
}
