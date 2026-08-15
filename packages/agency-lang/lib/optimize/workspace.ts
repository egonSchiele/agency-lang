import * as fs from "fs";

import { sha256Text } from "@/utils/hash.js";
import { type OptimizeTargetSet } from "./targets.js";

/** Per-candidate cache-partition token. `EvalCache` keys runs by
 *  `(key, inputId)`; under the new model nothing on-disk lives at the workspace
 *  itself — per-iteration artifacts live under `runs/<runId>/agent-runs/<key>/`,
 *  created by `runSuite` rather than here. */
export type CachePartition = { key: string };

/** Owns the per-candidate cache-identity counter. No filesystem ownership. */
export class WorkspaceManager {
  private counter = 0;

  /** Mint a fresh cache-partition token. */
  fork(): CachePartition {
    this.counter += 1;
    return { key: `ws-${this.counter}` };
  }

  /**
   * Write a champion file set back to the original sources, sha-checked: every
   * discovered file must still match its discovery-time hash, or the whole
   * writeback aborts. Only changed files are written. (Never took a CachePartition.)
   */
  writeBack(source: OptimizeTargetSet, championFiles: Record<string, string>): void {
    for (const sf of Object.values(source.files)) {
      if (sha256Text(fs.readFileSync(sf.absoluteFile, "utf8")) !== sf.sha256) {
        throw new Error(
          `Source file ${sf.absoluteFile} was modified externally; writeback aborted.`,
        );
      }
    }
    for (const [rel, contents] of Object.entries(championFiles)) {
      if (contents !== source.files[rel]?.source)
        fs.writeFileSync(source.files[rel].absoluteFile, contents);
    }
  }
}
