import { openDataset, type IngestResult, type LabelDataset } from "./dataset.js";
import type { LoadedBatch } from "./load/types.js";
import { acquireStoreLock } from "./lock.js";

export type DatasetWriteRequest = {
  datasetDir: string;
  batch: LoadedBatch;
  reportWarning(message: string): void;
};

/** The single owner of the lock -> open -> ingest -> close sequence, shared by
 *  the CLI and the viewer so neither reimplements the lifecycle (and neither
 *  forgets to release the lock on an ingest failure). */
export type DatasetWriter = {
  ingest(request: DatasetWriteRequest): IngestResult;
};

/** @internal Injected so lifecycle tests can force open/ingest failures. */
export type DatasetWriterDependencies = {
  acquireLock: typeof acquireStoreLock;
  openDataset: typeof openDataset;
};

const defaultDependencies: DatasetWriterDependencies = {
  acquireLock: acquireStoreLock,
  openDataset,
};

export function createDatasetWriter(
  dependencies: DatasetWriterDependencies = defaultDependencies,
): DatasetWriter {
  return {
    ingest(request: DatasetWriteRequest): IngestResult {
      const lock = dependencies.acquireLock({
        storeDir: request.datasetDir,
        reportWarning: request.reportWarning,
      });
      let dataset: LabelDataset | undefined;
      try {
        dataset = dependencies.openDataset({
          storeDir: request.datasetDir,
          lock,
          reportWarning: request.reportWarning,
        });
        return dataset.ingest(request.batch);
      } finally {
        dataset?.close();
        lock.release();
      }
    },
  };
}

/** The configured writer used in production. */
export const datasetWriter: DatasetWriter = createDatasetWriter();
