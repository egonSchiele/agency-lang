/**
 * The `agency doc` ownership ledger: one per physical output directory,
 * stored as a sidecar inside it (`.agency-doc.json`), plus the lock that
 * serializes every writer of that directory (`.agency-doc.lock`).
 *
 * Two kinds of evidence live here and must not be conflated:
 *  - FRESHNESS ("is this page current?") is computed from hashes and can
 *    be invalidated wholesale (identity or render-key changes) at no cost.
 *  - OWNERSHIP ("did we write this file?") is the prior ledger's entries,
 *    and ordinary invalidation must never discard them — they are the only
 *    evidence that authorizes deleting an obsolete page. Only
 *    corruption-shaped state (bad JSON, wrong version, a ledger naming a
 *    different directory, any malformed field) forfeits deletion
 *    authority; then the run re-renders everything and deletes nothing.
 *
 * Deletion never dereferences the stored `outputPath`: reconciliation
 * recomputes the deterministic mapping from the validated source key
 * (`outputPathFor`), and every owned-output path is resolved through
 * `resolveOwnedOutputPath`, which refuses symlinked ancestors — lexical
 * containment alone would follow `out/sub -> victim` outside the root.
 *
 * See docs/dev/doc-cache.md for the full design story.
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { AgencyConfig } from "@/config.js";
import {
  computeCompilerStamp,
  computeDepsHash,
  computeStdlibHash,
  computeStdlibNamesHash,
  deriveConfigKey,
  hashBytes,
  hashFile,
  stdlibHashFlavor,
} from "@/compiler/buildManifest.js";
import { dependencyFingerprint } from "@/compiler/depFingerprint.js";
import { getStdlibDir } from "@/importPaths.js";

export type DocLedgerEntry = {
  sourceHash: string;
  /** Absolute paths, exactly the fingerprint's sorted order — hashed in
   *  this stored order by writer and checker alike. */
  deps: string[];
  depsHash: string;
  cacheable: boolean;
  hasPkgImports: boolean;
  stdlibHash: string;
  compilerStamp: string;
  /** Output-dir-relative; informational only — deletion recomputes the
   *  deterministic mapping and never trusts this field. */
  outputPath: string;
  /** Hash of the Markdown bytes as written; a hand-edited or truncated
   *  page hashes differently and gets repaired. */
  outputHash: string;
  /** The file's pass-1 registry contributions (NOT "exports": includes
   *  non-exported and underscore-prefixed functions). */
  registrySymbols: string[];
  /** Every registry lookup this page's rendering made: name → target md
   *  path, or null for "rendered unlinked". Re-checked against the
   *  rebuilt registry every run. */
  linkTargets: Record<string, string | null>;
};

export type DocLedger = {
  version: 1;
  /** Realpath of the directory this ledger governs; a mismatch with the
   *  directory it was loaded from (copied tree) forfeits authority. */
  outputDir: string;
  /** Current invocation identity — data, not a namespace: changing it is
   *  a transition that reconciles, never a fresh start that forgets. */
  identity: { inputDir: string; ignoreDirs: string[] };
  renderKey: string;
  /** Keyed by validated input-dir-relative source path. */
  entries: Record<string, DocLedgerEntry>;
};

export const DOC_LEDGER_NAME = ".agency-doc.json";
export const DOC_LOCK_NAME = ".agency-doc.lock";

/** A safe ledger key: relative, normalized, no `..`, and ending exactly
 *  in `.agency`. The suffix rule is deletion-critical: `outputPathFor` on
 *  a non-`.agency` key like "README" would be a no-op mapping, and
 *  reconciliation could then delete a handmade `out/README`. */
export function isSafeSourceRel(rel: string): boolean {
  if (rel === "" || path.isAbsolute(rel)) {
    return false;
  }
  if (!rel.endsWith(".agency")) {
    return false;
  }
  if (path.normalize(rel) !== rel) {
    return false;
  }
  return !rel.split(path.sep).includes("..");
}

/** The deterministic source→page mapping. The ONLY place keys become
 *  output paths; throws on anything isSafeSourceRel rejects. */
export function outputPathFor(sourceRelPath: string): string {
  if (!isSafeSourceRel(sourceRelPath)) {
    throw new Error(`unsafe doc source key: '${sourceRelPath}'`);
  }
  return sourceRelPath.replace(/\.agency$/, ".md");
}

export class OwnedPathError extends Error {}

export type ResolvedOwnedOutputPath = { abs: string; leafIsSymlink: boolean };

/**
 * Resolve an owned output path, refusing symlinked ancestors. Walks each
 * EXISTING component under outDirReal with lstat; with `createParents`,
 * creates missing ones and re-verifies their realpath. A symlink at the
 * LEAF is reported, not followed: rendering and hashing must reject it,
 * while reconciliation may unlink the link itself.
 */
export function resolveOwnedOutputPath(
  outDirReal: string,
  outRel: string,
  opts?: { createParents?: boolean },
): ResolvedOwnedOutputPath {
  if (path.isAbsolute(outRel)) {
    throw new OwnedPathError(`absolute owned path: ${outRel}`);
  }
  const abs = path.resolve(outDirReal, outRel);
  if (!abs.startsWith(outDirReal + path.sep)) {
    throw new OwnedPathError(`escapes output root: ${outRel}`);
  }
  const parts = path.relative(outDirReal, abs).split(path.sep);
  let current = outDirReal;
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    let stat: fs.Stats | null;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = null;
    }
    if (stat === null) {
      if (!opts?.createParents) {
        break; // nothing below a missing component can exist either
      }
      fs.mkdirSync(current);
      if (fs.realpathSync(current) !== current) {
        throw new OwnedPathError(`created parent resolves elsewhere: ${current}`);
      }
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new OwnedPathError(`symlinked ancestor: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new OwnedPathError(`non-directory ancestor: ${current}`);
    }
  }
  let leafIsSymlink = false;
  try {
    leafIsSymlink = fs.lstatSync(abs).isSymbolicLink();
  } catch {
    /* absent leaf */
  }
  return { abs, leafIsSymlink };
}

/** Structured, not concatenated: a string boundary could alias two
 *  distinct (config, baseUrl) states. */
export function docRenderKey(config: AgencyConfig, effectiveBaseUrl: string): string {
  return hashBytes(
    JSON.stringify({ configKey: deriveConfigKey(config), baseUrl: effectiveBaseUrl }),
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive: one malformed nested value anywhere denies the WHOLE ledger
 *  authority — deletion evidence must be fully trustworthy or not at all. */
export function ledgerEntryHasValidShape(entry: unknown): entry is DocLedgerEntry {
  if (!isPlainObject(entry)) {
    return false;
  }
  return (
    typeof entry.sourceHash === "string" &&
    Array.isArray(entry.deps) &&
    entry.deps.every((d) => typeof d === "string" && path.isAbsolute(d)) &&
    typeof entry.depsHash === "string" &&
    typeof entry.cacheable === "boolean" &&
    typeof entry.hasPkgImports === "boolean" &&
    typeof entry.stdlibHash === "string" &&
    typeof entry.compilerStamp === "string" &&
    typeof entry.outputPath === "string" &&
    typeof entry.outputHash === "string" &&
    Array.isArray(entry.registrySymbols) &&
    entry.registrySymbols.every((s) => typeof s === "string") &&
    isPlainObject(entry.linkTargets) &&
    Object.values(entry.linkTargets).every((v) => v === null || typeof v === "string")
  );
}

/**
 * Load and FULLY validate the ledger before granting authority. Callers
 * never dereference an unvalidated field: `authority: true` implies every
 * top-level field, every entry, and every key checked out.
 */
export function loadDocLedger(outDirReal: string): { ledger: DocLedger | null; authority: boolean } {
  const file = path.join(outDirReal, DOC_LEDGER_NAME);
  if (!fs.existsSync(file)) {
    return { ledger: null, authority: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { ledger: null, authority: false };
  }
  if (!isPlainObject(parsed)) {
    return { ledger: null, authority: false };
  }
  const identity = parsed.identity;
  const valid =
    parsed.version === 1 &&
    parsed.outputDir === outDirReal &&
    isPlainObject(identity) &&
    typeof identity.inputDir === "string" &&
    Array.isArray(identity.ignoreDirs) &&
    identity.ignoreDirs.every((d: unknown) => typeof d === "string") &&
    typeof parsed.renderKey === "string" &&
    isPlainObject(parsed.entries) &&
    Object.entries(parsed.entries).every(
      ([key, entry]) => isSafeSourceRel(key) && ledgerEntryHasValidShape(entry),
    );
  if (!valid) {
    return { ledger: null, authority: false };
  }
  return { ledger: parsed as unknown as DocLedger, authority: true };
}

/** Atomic (tmp + rename), and refuses unsafe keys — a save must never
 *  produce a ledger that load would strip of authority. */
export function saveDocLedger(outDirReal: string, ledger: DocLedger): void {
  for (const key of Object.keys(ledger.entries)) {
    if (!isSafeSourceRel(key)) {
      throw new Error(`refusing to save unsafe doc ledger key: '${key}'`);
    }
  }
  const file = path.join(outDirReal, DOC_LEDGER_NAME);
  const tmpFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmpFile, file);
}

export type DocLock = { lockPath: string; token: string };

/**
 * O_EXCL acquire; stale locks are removed MANUALLY (auto-break races two
 * processes past the same dead lock). The token — not the pid — is the
 * ownership identity: the same process can acquire again later, and a
 * stale handle carrying only a pid could remove its successor's lock.
 */
export function acquireDocLock(outDirReal: string): DocLock {
  const lockPath = path.join(outDirReal, DOC_LOCK_NAME);
  const token = `${process.pid}:${randomUUID()}`;
  try {
    fs.writeFileSync(lockPath, token, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let holder = "unknown";
    try {
      holder = fs.readFileSync(lockPath, "utf-8").trim();
    } catch {
      /* raced away between our write attempt and this read */
    }
    throw new Error(
      `agency doc: ${lockPath} is held (${holder}). Concurrent doc runs ` +
        `against one output directory are not supported; if that run is ` +
        `dead, delete the lock file and retry.`,
    );
  }
  return { lockPath, token };
}

/** Removes only a lock still carrying our own token. Token verification
 *  narrows the successor-deletion window but read-then-unlink is not an
 *  atomic compare-and-delete — users must not remove a LIVE lock. */
export function releaseDocLock(lock: DocLock): void {
  let current: string;
  try {
    current = fs.readFileSync(lock.lockPath, "utf-8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`agency doc: could not read lock at release: ${e}`);
    return;
  }
  if (current !== lock.token) {
    return; // a successor's lock — never remove
  }
  try {
    fs.rmSync(lock.lockPath);
  } catch (e) {
    console.warn(`agency doc: could not remove own lock: ${e}`);
  }
}

export type DocFreshnessContext = {
  inputDir: string; // realpath
  outputDir: string; // realpath
  stdlibDir: string;
  stdlibHash: string; // contents flavor
  stdlibNamesHash: string; // names flavor
  compilerStamp: string;
};

export function buildDocFreshnessContext(
  inputDirReal: string,
  outDirReal: string,
): DocFreshnessContext {
  const stdlibDir = getStdlibDir();
  // Same resolution trick as manifestTracker: dist/lib relative to this
  // module in production; the source tree (an empty-ish stamp) under
  // vitest, where writer and checker agree.
  const distLib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return {
    inputDir: inputDirReal,
    outputDir: outDirReal,
    stdlibDir,
    stdlibHash: computeStdlibHash(stdlibDir),
    stdlibNamesHash: computeStdlibNamesHash(stdlibDir),
    compilerStamp: computeCompilerStamp(distLib),
  };
}

/**
 * Spec §3 checks 2–6 and 9. Checks 1/7 (identity, render key) are
 * ledger-level; check 8 (link re-check) needs the rebuilt registry and
 * lives in the doc command's flow.
 */
export function isDocEntryFresh(
  sourceRel: string,
  entry: DocLedgerEntry,
  ctx: DocFreshnessContext,
): boolean {
  if (!isSafeSourceRel(sourceRel) || !ledgerEntryHasValidShape(entry)) {
    return false;
  }
  if (entry.cacheable === false) {
    return false;
  }
  if (entry.hasPkgImports) {
    return false;
  }
  const absSource = path.join(ctx.inputDir, sourceRel);
  if (
    entry.stdlibHash !==
    stdlibHashFlavor(absSource, ctx.stdlibDir, ctx.stdlibNamesHash, ctx.stdlibHash)
  ) {
    return false;
  }
  if (entry.compilerStamp !== ctx.compilerStamp) {
    return false;
  }
  const sourceHash = hashFile(absSource);
  if (sourceHash === null || sourceHash !== entry.sourceHash) {
    return false;
  }
  const depHashes: string[] = [];
  for (const dep of entry.deps) {
    const h = hashFile(dep);
    if (h === null) {
      return false;
    }
    depHashes.push(h);
  }
  if (computeDepsHash(depHashes) !== entry.depsHash) {
    return false;
  }
  let resolved: ResolvedOwnedOutputPath;
  try {
    resolved = resolveOwnedOutputPath(ctx.outputDir, outputPathFor(sourceRel));
  } catch {
    return false; // symlinked ancestor: never read through it
  }
  if (resolved.leafIsSymlink) {
    return false;
  }
  const outHash = hashFile(resolved.abs);
  return outHash !== null && outHash === entry.outputHash;
}

/**
 * The one writer of entries, paired with isDocEntryFresh: dependencies
 * are stored in the fingerprint's exact sorted order and hashed in that
 * same order; a missing dependency hash forces `cacheable: false`.
 */
export function buildDocLedgerEntry(args: {
  sourceRel: string; // pre-validated by the caller's traversal
  ctx: DocFreshnessContext;
  config: AgencyConfig;
  registrySymbols: string[];
  linkTargets: Record<string, string | null>;
  writtenBytes: string;
}): DocLedgerEntry {
  const { sourceRel, ctx, config, registrySymbols, linkTargets, writtenBytes } = args;
  const absSource = path.join(ctx.inputDir, sourceRel);
  const fp = dependencyFingerprint(absSource, config, {
    resolveStdlib: absSource.startsWith(ctx.stdlibDir + path.sep),
  });
  const depHashes: string[] = [];
  let cacheable = fp.cacheable;
  for (const dep of fp.deps) {
    const h = hashFile(dep);
    if (h === null) {
      cacheable = false;
      depHashes.push("");
    } else {
      depHashes.push(h);
    }
  }
  return {
    sourceHash: hashFile(absSource) ?? "",
    deps: fp.deps,
    depsHash: computeDepsHash(depHashes),
    cacheable,
    hasPkgImports: fp.hasPkgImports,
    stdlibHash: stdlibHashFlavor(absSource, ctx.stdlibDir, ctx.stdlibNamesHash, ctx.stdlibHash),
    compilerStamp: ctx.compilerStamp,
    outputPath: outputPathFor(sourceRel),
    outputHash: hashBytes(writtenBytes),
    registrySymbols,
    linkTargets,
  };
}
