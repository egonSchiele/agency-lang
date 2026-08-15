/**
 * The incremental-build manifest: content-hash records that let a
 * BuildSession skip recompiling unchanged modules WITHOUT parsing anything.
 *
 * Leaf module by design (PR #466 review): imports only node built-ins and
 * config.js. It must never import from lib/cli/ — the commands →
 * buildSession → cli/util → commands cycle stays at three edges. That
 * leaf-ness is also why walkFiles below deliberately duplicates the
 * spirit of lib/cli/util.ts findRecursively: importing it would add the
 * fourth cycle edge. Reuse traded for isolation, on purpose.
 *
 * Invalidation fields (spec "The manifest"): each can only over-rebuild.
 *  - sourceHash: the module's own bytes. Unchanged source ⇒ unchanged
 *    import list ⇒ the recorded `deps` are still the true deps (the
 *    load-bearing soundness invariant — imports are part of the source).
 *  - deps + depsHash: recorded transitive agency imports, re-hashed from
 *    the recorded paths at check time via computeDepsHash — the ONE
 *    construction both writer and checker share. Missing dep = stale.
 *    Freshness ALSO requires every recorded dep to have a manifest entry
 *    whose OUTPUT exists: a skip never recurses into deps, so a deleted
 *    dep .js would otherwise survive the skip and ship a broken import.
 *  - stdlibHash, two flavors selected by stdlibHashFor: NON-stdlib entries
 *    store the full-content stdlib hash — the closure walker excludes
 *    std:: imports, so no depsHash can see a stdlib edit, yet stdlib
 *    content shapes their output (resolveReExports bakes resolved stdlib
 *    paths in); any stdlib edit rebuilds their world. STDLIB-RESIDENT
 *    entries instead store the names-only hash (computeStdlibNamesHash):
 *    their deps DO include std::-resolved per-file edges (recorded via
 *    dependencyFingerprint), so content changes are tracked per file and
 *    only add/remove/rename of a stdlib file rebuilds all of stdlib.
 *  - hasPkgImports: pkg:: imports are likewise closure-invisible and shape
 *    emitted imports; modules touching pkg:: are NEVER skipped. Subtree-
 *    wide when recorded via dependencyFingerprint.
 *  - cacheable: false when dependency discovery could not fully establish
 *    the subtree — a splice anywhere in it (splices expand at compile time
 *    and may legally emit imports, so raw-parse edges are not the true
 *    edges), or an unparseable/missing reachable file. Never fresh.
 *  - compilerStamp: content hash of the compiled compiler (dist/lib minus
 *    runtime/ and agents/). runtime/ because generated TEXT does not
 *    depend on runtime internals; agents/ because those are the agency
 *    compiler's OWN OUTPUT — including them would make every build
 *    invalidate the next (self-invalidation loop). Content, not mtimes:
 *    tsc-alias rewrites the whole outDir every build.
 *  - configKey: compiled output bakes config in.
 *
 * The MANIFEST decides whether to compile; parseCache remains an
 * intra-process memo consulted only once compilation is already happening.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { findProjectRoot } from "@/config.js";

export type ManifestEntry = {
  sourceHash: string;
  /** Transitive agency-import paths, manifest-dir-relative, sorted. */
  deps: string[];
  depsHash: string;
  stdlibHash: string;
  hasPkgImports: boolean;
  /** False when dependency discovery could not fully establish the
   *  subtree (splice anywhere in it, unparseable/missing reachable file).
   *  Such entries are recorded (outputFor keeps working) but never fresh. */
  cacheable: boolean;
  configKey: string;
  compilerStamp: string;
  /** Manifest-dir-relative output path. */
  outputPath: string;
};

export type BuildManifest = {
  version: 2;
  /** Keyed by manifest-dir-relative module path. */
  entries: Record<string, ManifestEntry>;
};

export const MANIFEST_DIR_NAME = ".agency-build";
const MANIFEST_FILE = "manifest.json";

export function manifestDirFor(entryFile: string): string {
  // Entries can be files OR directories (`agency compile someDir`): a
  // directory anchors the search (and the fallback) at itself, not its
  // parent — otherwise `.agency-build/` would pollute a sibling-containing
  // parent dir in agency.json-less projects.
  const abs = path.resolve(entryFile);
  const startDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const root = findProjectRoot(startDir);
  return root ?? startDir;
}

function emptyManifest(): BuildManifest {
  return { version: 2, entries: Object.create(null) };
}

export function loadManifest(manifestDir: string): BuildManifest {
  const file = path.join(manifestDir, MANIFEST_DIR_NAME, MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    return emptyManifest();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed?.version !== 2 || typeof parsed.entries !== "object" || parsed.entries === null) {
      return emptyManifest();
    }
    return { version: 2, entries: Object.assign(Object.create(null), parsed.entries) };
  } catch (e) {
    // A corrupt manifest only costs a full rebuild; log for traceability.
    console.warn(`agency: ignoring corrupt build manifest at ${file}: ${e}`);
    return emptyManifest();
  }
}

export function saveManifest(manifestDir: string, manifest: BuildManifest): void {
  const dir = path.join(manifestDir, MANIFEST_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, MANIFEST_FILE);
  // Atomic write: concurrent compiles get last-writer-wins, never a torn file.
  const tmpFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmpFile, file);
}

export function hashBytes(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function hashFile(absPath: string): string | null {
  if (!fs.existsSync(absPath)) {
    return null;
  }
  return hashBytes(fs.readFileSync(absPath));
}

/** THE construction of depsHash. Writer (manifestTracker) and checker
 *  (isEntryFresh) both call this; never inline the expression. */
export function computeDepsHash(depHashes: string[]): string {
  return hashBytes(JSON.stringify(depHashes));
}

/** Canonical config identity. JSON.stringify is order-stable here because
 *  every config passes through AgencyConfigSchema.safeParse (loadConfigSafe
 *  returns result.data), and zod rebuilds objects in SCHEMA shape order —
 *  guarded by the key-order test in lib/cli/precompile.test.ts. */
export function deriveConfigKey(config: unknown): string {
  return JSON.stringify(config);
}

// Deliberate near-duplicate of lib/cli/util.ts findRecursively — see the
// module doc comment (leaf-ness beats reuse here).
function walkFiles(dir: string, extension: string, skipDirs: string[]): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name)) {
          walk(child);
        }
      } else if (child.endsWith(extension)) {
        out.push(child);
      }
    }
  };
  if (fs.existsSync(dir)) {
    walk(dir);
  }
  return out.sort();
}

// NUL separators between path and content and between files: without a
// delimiter, path/content boundaries are ambiguous in principle.
function hashTree(dir: string, extension: string, skipDirs: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const file of walkFiles(dir, extension, skipDirs)) {
    hash.update(path.relative(dir, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function computeStdlibHash(stdlibDir: string): string {
  return hashTree(stdlibDir, ".agency", []);
}

/** Stdlib STRUCTURE only (sorted file list, no contents). Stdlib-resident
 *  entries carry this flavor: their per-file `deps` already track stdlib
 *  CONTENT, but re-export resolution bakes resolved stdlib PATHS into
 *  emitted output, so add/remove/rename must still rebuild the stdlib
 *  world while a plain edit no longer does. */
export function computeStdlibNamesHash(stdlibDir: string): string {
  const hash = crypto.createHash("sha256");
  for (const file of walkFiles(stdlibDir, ".agency", [])) {
    hash.update(path.relative(stdlibDir, file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function computeCompilerStamp(distLibDir: string): string {
  return hashTree(distLibDir, ".js", ["runtime", "agents"]);
}

export type FreshnessContext = {
  manifestDir: string;
  stdlibHash: string;
  /** Names-only flavor (computeStdlibNamesHash) for stdlib-resident
   *  entries; see stdlibHashFor. */
  stdlibNamesHash: string;
  /** Canonical absolute stdlib dir. Supplied by the tracker so this file
   *  never imports importPaths.ts (leaf-ness, see the header). */
  stdlibDir: string;
  compilerStamp: string;
  configKey: string;
};

/** ONE selection rule for which stdlib-hash flavor an entry carries.
 *  Pure and argument-only so non-compile consumers (the doc cache) can
 *  use it without fabricating a FreshnessContext. Writer and checker
 *  both route through it — never inline the comparison. */
export function stdlibHashFlavor(
  absModule: string,
  stdlibDir: string,
  namesHash: string,
  contentsHash: string,
): string {
  return absModule.startsWith(stdlibDir + path.sep) ? namesHash : contentsHash;
}

export function stdlibHashFor(absModule: string, ctx: FreshnessContext): string {
  return stdlibHashFlavor(absModule, ctx.stdlibDir, ctx.stdlibNamesHash, ctx.stdlibHash);
}

/**
 * The skip algorithm, from the manifest alone — no parsing:
 * 1. sourceHash matches (⇒ recorded deps are still the true deps);
 * 2. every recorded dep source exists and the recomputed depsHash matches;
 * 3. every recorded dep has a manifest entry whose OUTPUT exists — a skip
 *    never recurses into deps, so a deleted dep .js would otherwise
 *    survive the skip and ship a broken import;
 * 4. stdlibHash / compilerStamp / configKey match; hasPkgImports is false;
 * 5. the module's own recorded output exists.
 */
// A valid-but-malformed manifest (manual edit, older schema) must cost a
// rebuild, never a crash — validate the runtime shape of every field the
// checker touches before trusting it.
function entryHasValidShape(entry: ManifestEntry): boolean {
  return (
    typeof entry.sourceHash === "string" &&
    Array.isArray(entry.deps) &&
    entry.deps.every((d) => typeof d === "string") &&
    typeof entry.depsHash === "string" &&
    typeof entry.stdlibHash === "string" &&
    typeof entry.hasPkgImports === "boolean" &&
    typeof entry.cacheable === "boolean" &&
    typeof entry.configKey === "string" &&
    typeof entry.compilerStamp === "string" &&
    typeof entry.outputPath === "string"
  );
}

export function isEntryFresh(
  moduleRel: string,
  manifest: BuildManifest,
  ctx: FreshnessContext,
): boolean {
  const entry = manifest.entries[moduleRel];
  if (!entry || !entryHasValidShape(entry)) {
    return false;
  }
  if (entry.hasPkgImports) {
    return false;
  }
  if (entry.cacheable === false) {
    return false;
  }
  if (entry.stdlibHash !== stdlibHashFor(path.join(ctx.manifestDir, moduleRel), ctx)) {
    return false;
  }
  if (entry.compilerStamp !== ctx.compilerStamp) {
    return false;
  }
  if (entry.configKey !== ctx.configKey) {
    return false;
  }
  const sourceHash = hashFile(path.join(ctx.manifestDir, moduleRel));
  if (sourceHash === null || sourceHash !== entry.sourceHash) {
    return false;
  }
  const depHashes: string[] = [];
  for (const dep of entry.deps) {
    const depHash = hashFile(path.join(ctx.manifestDir, dep));
    if (depHash === null) {
      return false;
    }
    depHashes.push(depHash);
    const depEntry = manifest.entries[dep];
    if (!depEntry || typeof depEntry.outputPath !== "string") {
      return false;
    }
    if (!fs.existsSync(path.join(ctx.manifestDir, depEntry.outputPath))) {
      return false;
    }
  }
  if (computeDepsHash(depHashes) !== entry.depsHash) {
    return false;
  }
  return fs.existsSync(path.join(ctx.manifestDir, entry.outputPath));
}
