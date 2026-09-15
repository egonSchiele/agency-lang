import * as fs from "node:fs";
import * as path from "node:path";
import { writeMlxModelRecord } from "agency-lang/stdlib-lib/mlxModelRecord.js";
import { snapshotFor, type ModelName } from "../src/lockfile.js";
import { modelRepoDir } from "../src/modelStore.js";

type RecordChange = {
  revision?: string;
  incompletePath?: string;
};

/** Writes the downloader's record for `model`, as if every file had
 *  arrived. Each file is written as zeros at its pinned size, which the
 *  file system stores without using the disk space. */
export function recordInstalledModel(model: ModelName, change: RecordChange = {}): void {
  const snapshot = snapshotFor(model);
  for (const file of snapshot.files) {
    const onDisk = path.join(modelRepoDir(model), file.path);
    fs.mkdirSync(path.dirname(onDisk), { recursive: true });
    fs.writeFileSync(onDisk, "");
    fs.truncateSync(onDisk, file.size);
  }
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
