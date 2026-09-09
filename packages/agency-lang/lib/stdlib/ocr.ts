import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { z } from "zod";
import { fixedPath, readBytes, root, writeBytes, remove } from "./contained.js";

const execFileAsync = promisify(execFile);

/** Vision prints one JSON array per run. A dense page is well under a
 *  megabyte; the cap only guards against a runaway script. */
const OSASCRIPT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/** The JavaScript for Automation program that drives Vision. It ships
 *  beside this file (the makefile copies it into dist) and osascript
 *  runs it by path; the image path, language, and fast flag are argv. */
const VISION_SCRIPT_PATH = fileURLToPath(new URL("./visionOcr.jxa", import.meta.url));

/** Normalized to 0..1 with the origin at the top left, so `y` grows
 *  downward. */
const boundingBoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
});
export type BoundingBox = z.infer<typeof boundingBoxSchema>;

/** One line of recognized text. */
const textBlockSchema = z.object({
  text: z.string(),
  confidence: z.number().finite(),
  box: boundingBoxSchema,
});
export type TextBlock = z.infer<typeof textBlockSchema>;

const blocksSchema = z.array(textBlockSchema);

/** Runs osascript with the given argv and resolves with stdout. Injected
 *  so the tests never spawn a process. */
export type OsascriptRunner = (args: string[]) => Promise<string>;

export const NOT_MACOS_MESSAGE =
  "Vision OCR requires macOS. Use readTextWithModel to send the image to a " +
  "model provider, or install @agency-lang/tesseract-local for offline OCR on any platform.";

/** Parse the script's stdout into blocks. A partial or garbled print
 *  fails the parse and never reaches Agency as data. */
export function parseBlocks(stdout: string): TextBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error: unknown) {
    throw new Error(`Vision OCR script did not return JSON: ${(error as Error).message}`);
  }
  const result = blocksSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Vision OCR script returned a malformed block: ${result.error.message}`);
  }
  return result.data;
}

const defaultRunner: OsascriptRunner = async (args) => {
  const { stdout } = await execFileAsync("osascript", args, {
    maxBuffer: OSASCRIPT_MAX_STDOUT_BYTES,
  });
  return stdout;
};

/** Read the approved file through a validated descriptor. `approvedPath`
 *  is the spelling the approver saw; `fixedPath` refuses a symlink that
 *  appeared while the prompt was pending, and `readBytes` refuses a link
 *  at the final name or anything that is not a regular file. */
function readApprovedImage(approvedPath: string): Buffer {
  const located = fixedPath(approvedPath);
  return readBytes(located.root, located.target);
}

/** Run the Vision script over a temp copy of `bytes`. osascript opens a
 *  pathname itself, so it never gets the original path: it gets a file
 *  this call created from bytes that were already validated. Only a file
 *  this call created is removed afterwards. */
async function runVisionOnCopy(
  runner: OsascriptRunner,
  bytes: Buffer,
  extension: string,
  language: string,
  fast: boolean,
): Promise<string> {
  const tmpDir = root(os.tmpdir());
  const tmpName = `agency-ocr-${nanoid()}${extension}`;
  const tmpFile = path.join(tmpDir.real, tmpName);
  let owned = false;
  try {
    writeBytes(tmpDir, tmpName, bytes, { mode: "create-only" });
    owned = true;
    const args = ["-l", "JavaScript", VISION_SCRIPT_PATH, tmpFile, language, String(fast)];
    return await runner(args);
  } finally {
    if (owned) {
      remove(tmpDir, tmpName);
    }
  }
}

/** Backs `std::ocr.readTextBlocks` after its interrupt was approved. */
export async function _recognizeTextLocalWith(
  runner: OsascriptRunner,
  platform: string,
  approvedPath: string,
  language: string,
  fast: boolean,
): Promise<TextBlock[]> {
  if (platform !== "darwin") {
    throw new Error(NOT_MACOS_MESSAGE);
  }
  const bytes = readApprovedImage(approvedPath);
  const extension = path.extname(approvedPath).toLowerCase();
  let stdout: string;
  try {
    stdout = await runVisionOnCopy(runner, bytes, extension, language, fast);
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    const detail = (err.stderr ?? err.message ?? "").trim();
    throw new Error(`osascript failed while running Vision OCR: ${detail}`);
  }
  return parseBlocks(stdout);
}

export function _recognizeTextLocal(
  approvedPath: string,
  language: string,
  fast: boolean,
): Promise<TextBlock[]> {
  return _recognizeTextLocalWith(defaultRunner, process.platform, approvedPath, language, fast);
}
