import * as path from "path";

import { makeOutputId } from "./ids.js";
import { openJsonlStrict, type OpenedJsonl } from "./jsonl.js";
import { CorpusRowSchema, type CorpusRow, type Fields } from "./types.js";

export function corpusPath(storeDir: string): string {
  return path.join(storeDir, "outputs.jsonl");
}

export type EnsureRecordResult = {
  row: CorpusRow;
  added: boolean;
};

export type OpenedCorpusLog = {
  rows(): readonly CorpusRow[];
  find(outputId: string): CorpusRow | undefined;
  /**
   * Add this record, or return the one already stored.
   *
   * Like `ensureOccurrence`, this cannot be a plain `appendExact`: `capturedAt`
   * is not part of the identity, so a later ingest of the same fields would
   * build an identical id carrying a different timestamp and be rejected as
   * corruption. The first capture time is the truth.
   */
  ensureRecord(fields: Fields): EnsureRecordResult;
};

/** The copied artifacts. Kept private to the store and ingest layers: an
 *  annotation must never be able to reference a record nobody captured, which
 *  is only guaranteed while writes go through one path. */
export function openCorpusLog(storeDir: string): OpenedCorpusLog {
  const log: OpenedJsonl<CorpusRow> = openJsonlStrict({
    filePath: corpusPath(storeDir),
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
      const existing = log.find(outputId);
      if (existing !== undefined) {
        return { row: existing as CorpusRow, added: false };
      }

      const row = CorpusRowSchema.parse({
        schemaVersion: 2,
        outputId,
        capturedAt: new Date().toISOString(),
        fields,
      });
      log.appendExact(row);
      return { row, added: true };
    },
  };
}
