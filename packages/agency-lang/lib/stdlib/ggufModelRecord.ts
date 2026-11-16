import * as path from "node:path";
// The synchronous file operations of nodeHost, not host.files: local models are Node-only.
import { root, stat, list, readText, writeText, mkdir } from "../host/node/nodeFiles.js";
import { RECORD_FILE } from "./mlxModelRecord.js";
import { GGUF_SUBDIR, ggufModelDirName } from "./ggufModelDir.js";

/** The record in a GGUF model's folder. Written once the download has
 *  finished and passed its hash check, so a folder without one holds no
 *  usable model. `list` and `remove` read it instead of the file names. */
export type GgufModelRecord = {
  /** The URI the files were downloaded from. */
  uri: string;
  /** The file to load. For a model split across several files, the first
   *  part, which is the one llama.cpp is given. */
  entry: string;
  /** Every `.gguf` file in the folder, by name, with its size in bytes. */
  files: Record<string, number>;
};

export function ggufModelDir(cacheDir: string, uri: string): string {
  return path.join(cacheDir, GGUF_SUBDIR, ggufModelDirName(uri));
}

/** The record in `dir`, or null when it is missing or not a valid record. */
export function readGgufModelRecord(dir: string): GgufModelRecord | null {
  const r = root(dir);
  if (stat(r, RECORD_FILE) === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readText(r, RECORD_FILE));
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const rec = parsed as GgufModelRecord;
    if (
      typeof rec.uri !== "string" ||
      typeof rec.entry !== "string" ||
      rec.files === null ||
      typeof rec.files !== "object" ||
      !Object.values(rec.files).every((size) => typeof size === "number")
    ) {
      return null;
    }
    return { uri: rec.uri, entry: rec.entry, files: Object.assign(Object.create(null), rec.files) };
  } catch {
    return null;
  }
}

/** Record what a finished download left in `dir`: every `.gguf` file in
 *  it, and `entry` as the one to load. */
export function writeGgufModelRecord(dir: string, uri: string, entry: string): void {
  const r = root(dir);
  mkdir(r, ".");
  const files: Record<string, number> = {};
  for (const file of list(r, ".")) {
    if (file.type === "file" && file.name.endsWith(".gguf")) {
      files[file.name] = file.size;
    }
  }
  const record: GgufModelRecord = { uri, entry, files };
  writeText(r, RECORD_FILE, JSON.stringify(record, null, 2) + "\n");
}

export function ggufModelSizeBytes(record: GgufModelRecord): number {
  return Object.values(record.files).reduce((sum, size) => sum + size, 0);
}
