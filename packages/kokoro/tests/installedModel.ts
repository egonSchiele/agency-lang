import { writeMlxModelRecord } from "agency-lang/stdlib-lib/mlxModelRecord.js";
import { snapshotFor, type ModelName } from "../src/lockfile.js";
import { modelRepoDir } from "../src/modelStore.js";

type RecordChange = {
  revision?: string;
  incompletePath?: string;
};

/** Writes the downloader's record for `model`, as if every file had
 *  arrived, without writing the files themselves. */
export function recordInstalledModel(model: ModelName, change: RecordChange = {}): void {
  const snapshot = snapshotFor(model);
  const files = Object.fromEntries(
    snapshot.files.map((file) => [
      file.path,
      { size: file.size, sha256: file.sha256, complete: file.path !== change.incompletePath },
    ]),
  );
  writeMlxModelRecord(modelRepoDir(model), {
    repo: snapshot.repo,
    revision: change.revision ?? snapshot.revision,
    files,
  });
}
