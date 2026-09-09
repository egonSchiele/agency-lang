import { execFile } from "child_process";
import { promisify } from "util";
import * as os from "node:os";
import * as path from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { fixedPath, readBytes, root, writeBytes, remove } from "./contained.js";

const execFileAsync = promisify(execFile);

/** Vision prints one JSON array per run. A dense page is well under a
 *  megabyte; the cap only guards against a runaway script. */
const OSASCRIPT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;

/** Normalized to 0..1 with the origin at the TOP left, so `y` grows
 *  downward. Vision reports the bottom-left origin; the script flips it
 *  before printing. */
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

// JavaScript for Automation. The image path, language, and fast flag
// arrive as argv, never spliced into this source: the path is
// model-supplied text. Vision's boundingBox has its origin at the bottom
// left; the y flip makes the output top-left like every drawing API.
const VISION_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("Vision");
function run(argv) {
  const imagePath = argv[0];
  const language = argv[1];
  const fast = argv[2] === "true";
  const url = $.NSURL.fileURLWithPath(imagePath);
  const request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = fast
    ? $.VNRequestTextRecognitionLevelFast
    : $.VNRequestTextRecognitionLevelAccurate;
  if (language !== "") {
    request.recognitionLanguages = $([language]);
  }
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  const error = Ref();
  const ok = handler.performRequestsError($([request]), error);
  if (!ok) {
    throw new Error("Vision failed: " + ObjC.unwrap(error[0].localizedDescription));
  }
  const results = request.results;
  const out = [];
  for (let i = 0; i < results.count; i++) {
    const observation = results.objectAtIndex(i);
    const candidate = observation.topCandidates(1).objectAtIndex(0);
    const box = observation.boundingBox;
    out.push({
      text: ObjC.unwrap(candidate.string),
      confidence: candidate.confidence,
      box: {
        x: box.origin.x,
        y: 1 - (box.origin.y + box.size.height),
        width: box.size.width,
        height: box.size.height,
      },
    });
  }
  return JSON.stringify(out);
}
`;

export const NOT_MACOS_MESSAGE =
  "Vision OCR requires macOS. Use readTextWithModel to send the image to a " +
  "model provider, or install @agency-lang/tesseract-local for offline OCR on any platform.";

/** Parse the script's stdout into blocks. The schema says what a block
 *  is; a partial or garbled print fails the parse and never reaches
 *  Agency as data. */
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
 *  this call created from bytes that were already validated, the way
 *  `say` gets a temp text file in speech.ts. Only a file this call
 *  created is removed afterwards. */
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
    // No "-" before the arguments: osascript would pass it through as argv
    // item 1 and shift every real argument by one (see appleNotes.ts).
    const args = ["-l", "JavaScript", "-e", VISION_SCRIPT, tmpFile, language, String(fast)];
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
