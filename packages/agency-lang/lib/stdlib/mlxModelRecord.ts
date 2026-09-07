import * as path from "node:path";
import { root, stat, readText, writeText, mkdir } from "./contained.js";

/** MLX models live under `<modelsDir>/mlx/<org>--<repo>/`. */
export const MLX_SUBDIR = "mlx";

/** The per-model record: which revision the files came from and how much of
 *  each file is on disk. Written by the downloader, read by `list`, `serve`,
 *  and `remove`. */
export const RECORD_FILE = ".agency-model.json";

export type MlxFileRecord = {
  size: number;
  sha256?: string;
  complete: boolean;
  /** Indexes of the chunks already written, for a file still downloading. */
  chunks?: number[];
};

export type MlxModelRecord = {
  repo: string;
  revision: string;
  files: Record<string, MlxFileRecord>;
};

export function mlxModelDirName(repo: string): string {
  return repo.replace("/", "--");
}

export function mlxModelDir(cacheDir: string, repo: string): string {
  return path.join(cacheDir, MLX_SUBDIR, mlxModelDirName(repo));
}

/** The record in `dir`, or null when it is missing or not a valid record. */
export function readMlxModelRecord(dir: string): MlxModelRecord | null {
  const r = root(dir);
  if (stat(r, RECORD_FILE) === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readText(r, RECORD_FILE));
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const rec = parsed as MlxModelRecord;
    if (
      typeof rec.repo !== "string" ||
      typeof rec.revision !== "string" ||
      rec.files === null ||
      typeof rec.files !== "object"
    ) {
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

/** Replaces the file through a temp file and a rename, so a crash mid-write
 *  leaves the previous record. */
export function writeMlxModelRecord(dir: string, record: MlxModelRecord): void {
  const r = root(dir);
  mkdir(r, ".");
  writeText(r, RECORD_FILE, JSON.stringify(record, null, 2) + "\n");
}

export function isMlxModelComplete(record: MlxModelRecord): boolean {
  return Object.values(record.files).every((f) => f.complete);
}
