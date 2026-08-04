import * as path from "path";

import { makeOccurrenceId } from "./ids.js";
import { openJsonlStrict, type OpenedJsonl } from "./jsonl.js";
import {
  OccurrenceRowSchema,
  type OccurrenceCandidate,
  type OccurrenceRow,
} from "./types.js";

export function occurrencesPath(storeDir: string): string {
  return path.join(storeDir, "occurrences.jsonl");
}

export type EnsureOccurrenceResult = {
  row: OccurrenceRow;
  added: boolean;
};

export type OpenedOccurrenceLog = {
  rows(): readonly OccurrenceRow[];
  /**
   * Append this occurrence, or return the one already recorded.
   *
   * Replay goes through `find`, NOT through `appendExact`, and that is not an
   * oversight. `occurrenceId` excludes `firstObservedAt`, so re-ingesting the
   * same source tomorrow would build the same id carrying a different
   * timestamp; handing that to `appendExact` would look like identity reuse
   * with different content and raise a corruption error on a completely
   * legitimate operation. The stored timestamp is the truth, so an existing
   * row is returned untouched. `appendExact` is still what writes a row the
   * first time.
   */
  ensureOccurrence(candidate: OccurrenceCandidate): EnsureOccurrenceResult;
};

/** The provenance log: which sources were observed emitting which record.
 *  Private to the store, like the corpus, so an occurrence can never reference
 *  a record nobody wrote. */
export function openOccurrenceLog(storeDir: string): OpenedOccurrenceLog {
  const log: OpenedJsonl<OccurrenceRow> = openJsonlStrict({
    filePath: occurrencesPath(storeDir),
    schema: OccurrenceRowSchema,
    identityOf: (row) => row.occurrenceId,
  });

  return {
    rows(): readonly OccurrenceRow[] {
      return log.rows() as readonly OccurrenceRow[];
    },

    ensureOccurrence(candidate: OccurrenceCandidate): EnsureOccurrenceResult {
      const occurrenceId = makeOccurrenceId(candidate);
      const existing = log.find(occurrenceId);
      if (existing !== undefined) {
        return { row: existing as OccurrenceRow, added: false };
      }

      const row = OccurrenceRowSchema.parse({
        schemaVersion: 1,
        occurrenceId,
        outputId: candidate.outputId,
        source: candidate.source,
        firstObservedAt: new Date().toISOString(),
        origin: candidate.origin,
      });
      log.appendExact(row);
      return { row, added: true };
    },
  };
}
