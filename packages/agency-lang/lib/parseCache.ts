import fs from "fs";
import { parseAgency, ParseAgencyResult } from "./parser.js";
import { AgencyConfig } from "./config.js";
import { isNonTemplatedStdlib } from "./importPaths.js";
import { AgencyProgram } from "./types.js";

/**
 * Process-wide cache of successful `.agency` file parses.
 *
 * Motivation: neither `buildCompiledClosure` nor `SymbolTable.build` cached
 * parses, so every compile re-read and re-parsed the full auto-imported
 * stdlib prelude chain from disk (~90ms of a ~135ms trivial-file compile).
 * The test runner compiles hundreds of files per run, all sharing that chain.
 *
 * Correctness properties:
 *  - Keyed by absolute path; an entry is valid only while the file's
 *    `mtimeMs` AND `size` both match (size guards against same-mtime edits
 *    on filesystems with coarse timestamp granularity).
 *  - `applyTemplate` is part of the key: the same file parses to different
 *    programs with and without the CLI template prelude.
 *  - Returns a `structuredClone` of the cached program on every read —
 *    downstream passes mutate ASTs in place (import-path rewriting,
 *    typechecker annotation), so callers must never share one object.
 *  - Only successful parses are cached. Failures re-parse every time; the
 *    parser's module-global rightmost-failure state is per-parse and callers
 *    may read it after a failure.
 *  - Bypassed entirely (no read, no store) when `config.tarsecTraceHost` is
 *    set: tracing is the one config field the parse path reads, and a traced
 *    parse must actually run.
 *  - Pinned to `lower: true` parses. The formatter's `lower: false` path must
 *    not use this cache without adding `lower` to the key.
 */
type ParseCacheEntry = {
  mtimeMs: number;
  size: number;
  program: AgencyProgram;
};

const cache: Record<string, ParseCacheEntry> = {};

const stats = { hits: 0, misses: 0 };

export const _internal = {
  stats,
  clear: () => {
    for (const key of Object.keys(cache)) {
      delete cache[key];
    }
    stats.hits = 0;
    stats.misses = 0;
  },
};

export function parseAgencyFileCached(
  absPath: string,
  config: AgencyConfig = {},
  applyTemplate: boolean = !isNonTemplatedStdlib(absPath),
): ParseAgencyResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (e) {
    return {
      success: false,
      message: `Input file '${absPath}' not found`,
      rest: "",
    };
  }

  const bypass = !!config.tarsecTraceHost;
  const key = `${applyTemplate ? "t" : "r"}:${absPath}`;

  if (!bypass) {
    const entry = cache[key];
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
      stats.hits++;
      return {
        success: true,
        result: structuredClone(entry.program),
        rest: "",
      };
    }
  }

  const contents = fs.readFileSync(absPath, "utf-8");
  const result = parseAgency(contents, config, applyTemplate);
  if (bypass) return result;

  stats.misses++;
  if (result.success) {
    cache[key] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      // Clone on store as well as on read: the caller receives `result`
      // and may mutate it, which must not poison the cached copy.
      program: structuredClone(result.result),
    };
  }
  return result;
}
