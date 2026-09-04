// The spill directory: where tool output too long to hand to the model is
// kept, and the two ways it comes back out. One fixed place, outside every
// project, so the write goes somewhere the model never chose and nothing
// lands in a repository.
import { lstat, mkdir, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { sliceLines } from "./builtins.js";
import { compileGrepQuery } from "./grepQuery.js";
import { firstMatchingLines, type GrepMatch } from "./shell.js";
import { readContainedFile } from "../utils/readContainedFile.js";

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

/** The spill directory, created if needed. A symlink anywhere from the
 * home directory down is refused, so a link planted at `~/.agency-agent`
 * cannot redirect where saved output lands or where the readers look. */
async function spillDirReady(): Promise<string> {
  const dir = path.resolve(_spillDir());
  for (const candidate of [path.dirname(dir), dir]) {
    await refuseSymlink(candidate);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

async function refuseSymlink(p: string): Promise<void> {
  try {
    if ((await lstat(p)).isSymbolicLink()) {
      throw new Error(`refused: '${p}' is a symlink`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** Write `text` under the spill directory as `filename`. The file is
 * created fresh: an existing entry, a symlink included, is never opened. */
export async function _spillOutput(filename: string, text: string): Promise<string> {
  checkName(filename);
  const dir = await spillDirReady();
  await writeFile(path.join(dir, filename), text, { flag: "wx", mode: 0o600 });
  return path.join(dir, filename);
}

/** One saved file's text, read through a descriptor that is checked to sit
 * inside the spill directory, so a symlink named like a saved file leads
 * nowhere. */
async function readSaved(filename: string): Promise<string> {
  checkName(filename);
  const dir = await spillDirReady();
  return readContainedFile(dir, path.join(dir, filename));
}

/** The saved file, whole or a slice of lines; the same offset and limit
 * rules as `read`. */
export async function _readSpill(filename: string, offset: number, limit: number): Promise<string> {
  const text = await readSaved(filename);
  return sliceLines(text, offset, limit);
}

/** Lines matching `pattern` in one saved file. */
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
  const text = await readSaved(filename);
  return firstMatchingLines(text, plan, maxResults).map((hit) => ({ file: filename, ...hit }));
}
