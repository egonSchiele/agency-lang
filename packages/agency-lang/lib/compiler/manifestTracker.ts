/**
 * The single interpreter of freshness policy: it is resolved HERE, once
 * per operation — call sites in the session are unconditional one-liners,
 * and a no-op tracker absorbs the "always" case so no `freshness === ...`
 * comparison exists outside this factory.
 *
 * Division of labor: the SESSION owns the closure (so it computes deps
 * and hasPkgImports); the TRACKER owns policy, hashing, and storage.
 */
import * as path from "path";
import { AgencyConfig } from "@/config.js";
import { getStdlibDir } from "@/importPaths.js";
import { fileURLToPath } from "url";
import {
  computeCompilerStamp,
  computeDepsHash,
  computeStdlibHash,
  hashFile,
  isEntryFresh,
  loadManifest,
  manifestDirFor,
  saveManifest,
  type BuildManifest,
  type FreshnessContext,
} from "./buildManifest.js";

/** "incremental" consults and records the manifest; "force" recompiles
 *  everything but rewrites it (--force); "always" is internal
 *  (allowTestImports / --ts / caller-supplied importStrategy) and touches
 *  nothing. */
export type Freshness = "incremental" | "always" | "force";

export type ManifestTracker = {
  /** False unless policy allows reads AND the entry passes isEntryFresh. */
  isFresh(absModule: string): boolean;
  allFresh(absModules: string[]): boolean;
  /** The recorded output path for a module (fast-path return value). */
  outputFor(absModule: string): string | null;
  /** No-op unless policy allows writes. deps/hasPkgImports supplied by the
   *  session (it owns the closure); the tracker owns hashing and storage. */
  record(absModule: string, absOutput: string, deps: string[], hasPkgImports: boolean): void;
  /** Persist (atomic). No-op unless something was recorded. */
  flush(): void;
};

export const NOOP_TRACKER: ManifestTracker = {
  isFresh: () => false,
  allFresh: () => false,
  outputFor: () => null,
  record: () => {},
  flush: () => {},
};

class RealManifestTracker implements ManifestTracker {
  private manifest: BuildManifest;
  private ctx: FreshnessContext;
  private dirty = false;

  constructor(
    private manifestDir: string,
    private readsEnabled: boolean,
    configKey: string,
  ) {
    this.manifest = loadManifest(manifestDir);
    // The compiled compiler lives at dist/lib relative to this module
    // (dist/lib/compiler/manifestTracker.js) — works for repo dev and
    // installed packages alike. KNOWN + load-bearing-consistent: under
    // vitest this module runs from lib/, so distLib resolves to the source
    // tree with ~no .js — writer and checker agree on that (empty-ish)
    // stamp, so tests are sound. Do not "fix" one side of this.
    const distLib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    this.ctx = {
      manifestDir,
      stdlibHash: computeStdlibHash(getStdlibDir()),
      compilerStamp: computeCompilerStamp(distLib),
      configKey,
    };
  }

  isFresh(absModule: string): boolean {
    if (!this.readsEnabled) {
      return false;
    }
    const rel = path.relative(this.manifestDir, absModule);
    // Whole manifest, not one entry: freshness includes dep entries and
    // dep OUTPUTS — a skip never recurses into deps, so a deleted dep .js
    // would otherwise survive the skip and ship a broken import.
    return isEntryFresh(rel, this.manifest, this.ctx);
  }

  allFresh(absModules: string[]): boolean {
    if (absModules.length === 0) {
      return false;
    }
    return absModules.every((m) => this.isFresh(m));
  }

  outputFor(absModule: string): string | null {
    const rel = path.relative(this.manifestDir, absModule);
    const entry = this.manifest.entries[rel];
    if (!entry) {
      return null;
    }
    return path.join(this.manifestDir, entry.outputPath);
  }

  record(absModule: string, absOutput: string, deps: string[], hasPkgImports: boolean): void {
    const relDeps = deps.map((d) => path.relative(this.manifestDir, d)).sort();
    const depHashes = relDeps.map((d) => hashFile(path.join(this.manifestDir, d)) ?? "");
    this.manifest.entries[path.relative(this.manifestDir, absModule)] = {
      sourceHash: hashFile(absModule) ?? "",
      deps: relDeps,
      depsHash: computeDepsHash(depHashes),
      stdlibHash: this.ctx.stdlibHash,
      hasPkgImports,
      configKey: this.ctx.configKey,
      compilerStamp: this.ctx.compilerStamp,
      outputPath: path.relative(this.manifestDir, absOutput),
    };
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) {
      return;
    }
    saveManifest(this.manifestDir, this.manifest);
    this.dirty = false;
  }
}

/** Policy is resolved HERE, once:
 *  "always" → the shared NOOP tracker (no state, no IO, isFresh always false)
 *  "force"  → real tracker with reads disabled, writes on
 *  "incremental" → real tracker, reads + writes on. */
export function createManifestTracker(
  _config: AgencyConfig,
  entryFile: string,
  freshness: Freshness,
  configKey: string,
): ManifestTracker {
  if (freshness === "always") {
    return NOOP_TRACKER;
  }
  return new RealManifestTracker(manifestDirFor(entryFile), freshness === "incremental", configKey);
}
