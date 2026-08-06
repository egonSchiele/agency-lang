/**
 * The dependency-fingerprint contract shared by the compile manifest and
 * the doc cache: what does this module transitively depend on, and can
 * that answer be trusted for caching?
 *
 * Classified discovery failures (parse failures, filesystem errors while
 * reading candidates) degrade to `cacheable: false`; anything else
 * propagates — a blanket catch would hide resolver/AST bugs by silently
 * pinning modules stale. Splice-containing subtrees are never cacheable:
 * splices expand during compilation and may legally emit imports, so
 * raw-parse edges are not the true edges there.
 *
 * Runs on the record path, after the module already compiled and emitted;
 * a discovery problem must degrade to "don't cache this entry", never turn
 * that success into a failure.
 */
import { AgencyConfig } from "@/config.js";
import { parseAgencyFileCached } from "@/parseCache.js";
import { isNonTemplatedStdlib, isPkgImport } from "@/importPaths.js";
import { walkNodes } from "@/utils/node.js";
import { agencyImportTarget, agencyImportTargets } from "./compileClosure.js";

export type DependencyFingerprint = {
  /** Transitive .agency deps, absolute, unique, sorted, root excluded. */
  deps: string[];
  /** True if ANY module in the subtree (root included) has a pkg:: edge. */
  hasPkgImports: boolean;
  /** False when the subtree could not be fully established. */
  cacheable: boolean;
  /** Why cacheable is false — diagnostics/tests only, never persisted. */
  reason?: string;
};

/** Errors the walk absorbs: an ENUMERATED set of filesystem errnos from
 *  stat/read races behind parseAgencyFileCached. Everything else —
 *  including string-coded programming errors like ERR_INVALID_ARG_TYPE —
 *  must surface; a has-a-code check would silently pin modules stale on
 *  real bugs. (Resolver throws are a vacuous class here: pkg:: is
 *  filtered before resolution — see docs/dev/incremental-builds.md.) */
const DISCOVERY_FS_CODES = [
  "ENOENT", "EACCES", "EPERM", "EIO", "EBUSY", "EMFILE", "ENFILE", "EISDIR",
  // The stat-then-read race can also surface these (ancestor replaced by a
  // file, symlink loop appears, network-fs handle goes stale):
  "ENOTDIR", "ELOOP", "ESTALE",
];

function isDiscoveryFsError(e: unknown): boolean {
  return DISCOVERY_FS_CODES.includes((e as NodeJS.ErrnoException)?.code ?? "");
}

export function dependencyFingerprint(
  rootAbsPath: string,
  config: AgencyConfig,
  opts: { resolveStdlib: boolean },
): DependencyFingerprint {
  // Null-prototype: keyed by absolute file paths, which can legally
  // collide with inherited keys like __proto__.
  const visited: Record<string, true> = Object.create(null);
  let hasPkgImports = false;
  let cacheable = true;
  let reason: string | undefined;
  const flag = (why: string) => {
    cacheable = false;
    reason ??= why;
  };

  const queue = [rootAbsPath];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited[file]) continue;
    visited[file] = true;

    let parsed;
    try {
      parsed = parseAgencyFileCached(file, config, !isNonTemplatedStdlib(file));
    } catch (e) {
      if (!isDiscoveryFsError(e)) throw e;
      flag(`read failed for ${file}: ${e}`);
      continue;
    }
    if (!parsed.success) {
      // Missing or unparseable: it stays in deps (missing ⇒ null hash ⇒
      // stale at check time), but its own imports are unknowable.
      flag(`parse failed for ${file}: ${parsed.message ?? "unknown"}`);
      continue;
    }
    const program = parsed.result;

    for (const { node } of walkNodes(program.nodes)) {
      if (node.type === "splice") {
        flag(`splice in ${file}`);
        break;
      }
    }
    for (const node of program.nodes) {
      const target = agencyImportTarget(node);
      if (target && isPkgImport(target)) {
        hasPkgImports = true;
      }
    }

    // Not wrapped: pkg:: (the only throwing resolution class) is filtered
    // inside agencyImportTargets before resolution; std::/relative
    // resolution is pure path arithmetic.
    for (const target of agencyImportTargets(program, file, {
      resolveStdlib: opts.resolveStdlib,
    })) {
      if (!visited[target]) queue.push(target);
    }
  }

  delete visited[rootAbsPath];
  return {
    deps: Object.keys(visited).sort(),
    hasPkgImports,
    cacheable,
    reason,
  };
}
