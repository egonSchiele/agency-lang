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
  /** Add this occurrence, or return the one already recorded, keeping its first
   *  `firstObservedAt`. See `findOrAppend` for why replay cannot go through
   *  `appendExact`. */
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
      return log.findOrAppend(occurrenceId, () => OccurrenceRowSchema.parse({
        schemaVersion: 1,
        occurrenceId,
        outputId: candidate.outputId,
        source: candidate.source,
        firstObservedAt: new Date().toISOString(),
        origin: candidate.origin,
      }));
    },
  };
}
