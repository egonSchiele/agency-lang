import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { success, failure, type ResultValue } from "../runtime/result.js";
import type { Host } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";
import { approvedFilePath } from "./approvedPath.js";
import { configuredPython } from "./localPython.js";
import type { BoundingBox } from "./ocr.js";

/** The TypeScript half of `cropImage`, `imageSize`, and `pasteImages` in
 *  `std::image`. The pixel work runs in `lib/cli/imageTools.py` through
 *  the Python `agency local serve` uses, once per call, since Pillow is
 *  already there and the core package has no image library. Each call is
 *  one process that prints one JSON line. */

/** The script shipped next to the server scripts, copied into dist like
 *  them. */
export function imageToolsScript(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "imageTools.py");
}

/** Starting an interpreter and importing Pillow takes well under a second;
 *  a paste of a hundred large images a few. */
const TOOL_TIMEOUT_MS = 60_000;

type ToolResult = Record<string, unknown>;

/** Runs one command and returns its JSON line, or the reason it failed.
 *  Nothing here reads or writes a file: the script does, on paths this
 *  module has already checked. */
export async function _runImageTool(args: string[]): Promise<ToolResult | { error: string }> {
  const python = configuredPython();
  return new Promise((resolve) => {
    const child = spawn(python, [imageToolsScript(), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill(), TOOL_TIMEOUT_MS);
    child.on("error", (spawnError) => {
      clearTimeout(timer);
      resolve({
        error: `${python} could not be run (${spawnError.message}). The image tools need the Python agency local serve uses, with Pillow installed.`,
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ error: err.trim() === "" ? `imageTools.py exited with ${code}` : err.trim() });
        return;
      }
      try {
        resolve(JSON.parse(out) as ToolResult);
      } catch {
        resolve({ error: `imageTools.py printed something that is not JSON: ${out.trim()}` });
      }
    });
  });
}

/** The output path, once its parent is a real directory with no symlink
 *  in the spelling and the file itself is not there yet. The script
 *  creates it with mode x, so a race to create it fails there too. */
async function checkOutputPath(host: Host, spelling: string): Promise<string | { error: string }> {
  try {
    const located = await host.files.fixedPath(spelling);
    const resolved = await host.files.resolvePath(located.root, located.target);
    if ((await host.files.stat(located.root, located.target)) !== null) {
      return { error: `${resolved} already exists. Remove it first, or write elsewhere.` };
    }
    return resolved;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const boxArgs = (box: BoundingBox): string[] =>
  [box.x, box.y, box.width, box.height].map((n) => String(n));

/** Backs `cropImage`: `spelling` and `outSpelling` are the real paths the
 *  effect named. */
export async function _cropImage(
  spelling: string,
  box: BoundingBox,
  outSpelling: string,
  pad: number,
  square: boolean,
): Promise<ResultValue> {
  const host = currentHost();
  const fail = (message: string) => failure(`cropImage failed: ${message}`);
  let source: string;
  try {
    source = await approvedFilePath(host, spelling);
  } catch (err) {
    return fail((err as Error).message);
  }
  const out = await checkOutputPath(host, outSpelling);
  if (typeof out !== "string") {
    return fail(out.error);
  }
  const result = await _runImageTool([
    "crop",
    source,
    out,
    ...boxArgs(box),
    String(pad),
    square ? "true" : "false",
  ]);
  if ("error" in result) {
    return fail(String(result.error));
  }
  return success(result.path);
}

/** Backs `imageSize`. */
export async function _imageSize(spelling: string): Promise<ResultValue> {
  const host = currentHost();
  let source: string;
  try {
    source = await approvedFilePath(host, spelling);
  } catch (err) {
    return failure(`imageSize failed: ${(err as Error).message}`);
  }
  const result = await _runImageTool(["size", source]);
  if ("error" in result) {
    return failure(`imageSize failed: ${String(result.error)}`);
  }
  return success({ width: result.width, height: result.height });
}

/** Backs `pasteImages`: every input is a real path the effect listed. */
export async function _pasteImages(
  spellings: string[],
  outSpelling: string,
  columns: number,
): Promise<ResultValue> {
  const host = currentHost();
  const fail = (message: string) => failure(`pasteImages failed: ${message}`);
  const sources: string[] = [];
  for (const spelling of spellings) {
    try {
      sources.push(await approvedFilePath(host, spelling));
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  const out = await checkOutputPath(host, outSpelling);
  if (typeof out !== "string") {
    return fail(out.error);
  }
  const result = await _runImageTool(["paste", out, String(columns), ...sources]);
  if ("error" in result) {
    return fail(String(result.error));
  }
  return success(result.path);
}
