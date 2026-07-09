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
 *  - stdlibHash: the closure walker EXCLUDES std:: imports, so no depsHash
 *    can see a stdlib edit — yet stdlib content genuinely shapes emitted
 *    output (resolveReExports bakes resolved stdlib paths in). Any stdlib
 *    edit rebuilds the world.
 *  - hasPkgImports: pkg:: imports are likewise closure-invisible and shape
 *    emitted imports; modules touching pkg:: are NEVER skipped.
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
  configKey: string;
  compilerStamp: string;
  /** Manifest-dir-relative output path. */
  outputPath: string;
};

export type BuildManifest = {
  version: 1;
  /** Keyed by manifest-dir-relative module path. */
  entries: Record<string, ManifestEntry>;
};

export const MANIFEST_DIR_NAME = ".agency-build";
const MANIFEST_FILE = "manifest.json";

export function manifestDirFor(entryFile: string): string {
  const root = findProjectRoot(path.dirname(path.resolve(entryFile)));
  return root ?? path.dirname(path.resolve(entryFile));
}

function emptyManifest(): BuildManifest {
  return { version: 1, entries: Object.create(null) };
}

export function loadManifest(manifestDir: string): BuildManifest {
  const file = path.join(manifestDir, MANIFEST_DIR_NAME, MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    return emptyManifest();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
      return emptyManifest();
    }
    return { version: 1, entries: Object.assign(Object.create(null), parsed.entries) };
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

export function computeCompilerStamp(distLibDir: string): string {
  return hashTree(distLibDir, ".js", ["runtime", "agents"]);
}

export type FreshnessContext = {
  manifestDir: string;
  stdlibHash: string;
  compilerStamp: string;
  configKey: string;
};

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
export function isEntryFresh(
  moduleRel: string,
  manifest: BuildManifest,
  ctx: FreshnessContext,
): boolean {
  const entry = manifest.entries[moduleRel];
  if (!entry) {
    return false;
  }
  if (entry.hasPkgImports) {
    return false;
  }
  if (entry.stdlibHash !== ctx.stdlibHash) {
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
    if (!depEntry) {
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
