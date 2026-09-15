import * as os from "node:os";
import * as path from "node:path";
import { downloadHubSnapshot, type DownloadEvent } from "agency-lang/stdlib-lib/hubDownload.js";
import { readMlxModelRecord } from "agency-lang/stdlib-lib/mlxModelRecord.js";
import { LOCKFILE, snapshotFor, type ModelName } from "./lockfile.js";

export type ModelStatus = {
  installed: boolean;
  sizeBytes: number;
  source: string;
};

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

export function modelStatus(model: ModelName): ModelStatus {
  const snapshot = snapshotFor(model);
  const record = readMlxModelRecord(modelRepoDir(model));
  const installed =
    record !== null &&
    record.revision === snapshot.revision &&
    snapshot.files.every((file) => record.files[file.path]?.complete === true);
  return {
    installed,
    sizeBytes: snapshot.files.reduce((total, file) => total + file.size, 0),
    source: `https://huggingface.co/${snapshot.repo}/tree/${snapshot.revision}`,
  };
}

export async function downloadModel(
  model: ModelName,
  onEvent?: (event: DownloadEvent) => void,
): Promise<void> {
  await downloadHubSnapshot(snapshotFor(model), modelRepoDir(model), { onEvent });
}
