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
};

export type DownloadModelOptions = Pick<DownloadOptions, "onEvent" | "signal">;

export function modelsDir(): string {
  return (
    process.env.AGENCY_KOKORO_MODELS_DIR || path.join(os.homedir(), ".agency", "models", "kokoro")
  );
}

/** Each model gets its own directory, because the downloader's record
 *  lists only the files of the last snapshot it fetched into a directory.
 *  transformers.js loads `<modelDir>/<repo>/<file>`. */
export function modelDir(model: ModelName): string {
  return path.join(modelsDir(), model);
}

export function modelRepoDir(model: ModelName): string {
  return path.join(modelDir(model), LOCKFILE.repo);
}

/** Installed means the downloader's record lists every file as complete at
 *  the pinned revision, and every file is on disk at its pinned size. It
 *  does not hash the files. `agency-kokoro verify` does that. */
export function modelStatus(model: ModelName): ModelStatus {
  const snapshot = snapshotFor(model);
  const record = readMlxModelRecord(modelRepoDir(model));
  const installed =
    record !== null &&
    record.revision === snapshot.revision &&
    snapshot.files.every((file) => record.files[file.path]?.complete === true) &&
    filesOnDisk(modelRepoDir(model), snapshot.files);
  return {
    installed,
    sizeBytes: snapshot.files.reduce((total, file) => total + file.size, 0),
    source: `https://huggingface.co/${snapshot.repo}/tree/${snapshot.revision}`,
  };
}

function filesOnDisk(dir: string, files: HubFile[]): boolean {
  const repoRoot = root(dir);
  return files.every((file) => stat(repoRoot, file.path)?.size === file.size);
}

export async function downloadModel(
  model: ModelName,
  options: DownloadModelOptions = {},
): Promise<void> {
  await downloadHubSnapshot(snapshotFor(model), modelRepoDir(model), options);
}
