import * as os from "node:os";
import * as path from "node:path";
import { root, stat } from "agency-lang/stdlib-lib/contained.js";
import {
  downloadHubSnapshot,
  type DownloadOptions,
  type HubFile,
} from "agency-lang/stdlib-lib/hubDownload.js";
import { readMlxModelRecord } from "agency-lang/stdlib-lib/mlxModelRecord.js";
import { LOCKFILE, snapshotFor, type ModelName } from "./lockfile.js";

export type ModelStatus = {
  installed: boolean;
  sizeBytes: number;
  source: string;
  /** The directory this model lives in, whether or not it is installed. */
  dir: string;
};

export type DownloadModelOptions = Pick<DownloadOptions, "onEvent" | "signal">;

/** The directory models are kept in: the caller's choice when given, then
 *  `AGENCY_KOKORO_MODELS_DIR`, then `~/.agency/models/kokoro`. */
export function resolveModelsDir(override: string | null): string {
  if (override !== null && override !== "") {
    return override;
  }
  return (
    process.env.AGENCY_KOKORO_MODELS_DIR || path.join(os.homedir(), ".agency", "models", "kokoro")
  );
}

/** Each model gets its own directory, because the downloader's record
 *  lists only the files of the last snapshot it fetched into a directory.
 *  transformers.js loads `<modelDir>/<repo>/<file>`. */
export function modelDir(model: ModelName, modelsDir: string): string {
  return path.join(modelsDir, model);
}

export function modelRepoDir(model: ModelName, modelsDir: string): string {
  return path.join(modelDir(model, modelsDir), LOCKFILE.repo);
}

/** Installed means the downloader's record lists every file as complete at
 *  the pinned revision, and every file is on disk at its pinned size. It
 *  does not hash the files. `agency-kokoro verify` does that. */
export function modelStatus(model: ModelName, modelsDir: string): ModelStatus {
  const snapshot = snapshotFor(model);
  const repoDir = modelRepoDir(model, modelsDir);
  const record = readMlxModelRecord(repoDir);
  const installed =
    record !== null &&
    record.revision === snapshot.revision &&
    snapshot.files.every((file) => record.files[file.path]?.complete === true) &&
    filesOnDisk(repoDir, snapshot.files);
  return {
    installed,
    sizeBytes: snapshot.files.reduce((total, file) => total + file.size, 0),
    source: `https://huggingface.co/${snapshot.repo}/tree/${snapshot.revision}`,
    dir: modelDir(model, modelsDir),
  };
}

function filesOnDisk(dir: string, files: HubFile[]): boolean {
  const repoRoot = root(dir);
  return files.every((file) => stat(repoRoot, file.path)?.size === file.size);
}

export async function downloadModel(
  model: ModelName,
  modelsDir: string,
  options: DownloadModelOptions = {},
): Promise<void> {
  await downloadHubSnapshot(snapshotFor(model), modelRepoDir(model, modelsDir), options);
}
