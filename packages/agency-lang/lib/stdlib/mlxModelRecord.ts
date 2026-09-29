import * as path from "node:path";
import { root, stat, readText, writeText, mkdir } from "./contained.js";
import type { ServedBackend } from "./modelBackend.js";
import { isModelKind, type ModelKind } from "./modelKind.js";

/** MLX models live under `<modelsDir>/mlx/<org>--<repo>/`. */
export const MLX_SUBDIR = "mlx";

/** The folder under the models directory that each served backend
 *  downloads into. Diffusers models live under
 *  `<modelsDir>/diffusers/<org>--<repo>/`, with the same record. */
export const SUBDIR_FOR_BACKEND: Record<ServedBackend, string> = {
  mlx: MLX_SUBDIR,
  diffusers: "diffusers",
};

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
  /** What the model takes and returns, written when the download finished.
   *  Absent in records written before kinds existed, and for a directory
   *  whose files matched no rule; readers infer it then. */
  kind?: ModelKind;
};

export function mlxModelDirName(repo: string): string {
  return repo.replace("/", "--");
}

export function servedModelDir(cacheDir: string, backend: ServedBackend, repo: string): string {
  return path.join(cacheDir, SUBDIR_FOR_BACKEND[backend], mlxModelDirName(repo));
}

function isFileRecord(v: unknown): v is MlxFileRecord {
  if (v === null || typeof v !== "object") {
    return false;
  }
  const f = v as Record<string, unknown>;
  return (
    typeof f.size === "number" &&
    typeof f.complete === "boolean" &&
    (f.sha256 === undefined || typeof f.sha256 === "string") &&
    (f.chunks === undefined ||
      (Array.isArray(f.chunks) && f.chunks.every((c) => typeof c === "number")))
  );
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
      typeof rec.files !== "object" ||
      !Object.values(rec.files).every(isFileRecord)
    ) {
      return null;
    }
    const record: MlxModelRecord = {
      repo: rec.repo,
      revision: rec.revision,
      files: Object.assign(Object.create(null), rec.files),
    };
    // A kind this build does not know is left out rather than trusted: the
    // readers infer one from the files, as for a record with none.
    if (isModelKind(rec.kind)) {
      record.kind = rec.kind;
    }
    return record;
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
