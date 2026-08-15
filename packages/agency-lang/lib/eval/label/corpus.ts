import * as path from "path";

import { makeOutputId } from "./ids.js";
import { openJsonlStrict, type OpenedJsonl } from "./jsonl.js";
import { CorpusRowSchema, type CorpusRow, type Fields } from "./types.js";

export function corpusPath(datasetDir: string): string {
  return path.join(datasetDir, "outputs.jsonl");
}

export type EnsureRecordResult = {
  row: CorpusRow;
  added: boolean;
};

export type OpenedCorpusLog = {
  rows(): readonly CorpusRow[];
  find(outputId: string): CorpusRow | undefined;
  /** Add this record, or return the one already stored, keeping its first
   *  `capturedAt`. See `findOrAppend` for why replay cannot go through
   *  `appendExact`. */
  ensureRecord(fields: Fields): EnsureRecordResult;
};

/** The copied artifacts. Kept private to the dataset and ingest layers: an
 *  annotation must never be able to reference a record nobody captured, which
 *  is only guaranteed while writes go through one path. */
export function openCorpusLog(datasetDir: string): OpenedCorpusLog {
  const log: OpenedJsonl<CorpusRow> = openJsonlStrict({
    filePath: corpusPath(datasetDir),
    schema: CorpusRowSchema,
    identityOf: (row) => row.outputId,
  });

  return {
    rows(): readonly CorpusRow[] {
      return log.rows() as readonly CorpusRow[];
    },

    find(outputId: string): CorpusRow | undefined {
      return log.find(outputId) as CorpusRow | undefined;
    },

    ensureRecord(fields: Fields): EnsureRecordResult {
      const outputId = makeOutputId(fields);
      return log.findOrAppend(outputId, () =>
        CorpusRowSchema.parse({
          schemaVersion: 2,
          outputId,
          capturedAt: new Date().toISOString(),
          fields,
        }),
      );
    },
  };
}
