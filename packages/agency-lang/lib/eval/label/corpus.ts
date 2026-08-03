import * as path from "path";

import { openJsonlStrict, type OpenedJsonl } from "./jsonl.js";
import { CorpusRowSchema, type CorpusRow } from "./types.js";

export function corpusPath(storeDir: string): string {
  return path.join(storeDir, "outputs.jsonl");
}

/** The copied outputs. Kept private to the store and capture layers: an
 *  annotation must never be able to reference a row nobody captured, which is
 *  only guaranteed while writes go through one path. */
export function openCorpusLog(storeDir: string): OpenedJsonl<CorpusRow> {
  return openJsonlStrict({
    filePath: corpusPath(storeDir),
    schema: CorpusRowSchema,
    identityOf: (row) => row.outputId,
  });
}
