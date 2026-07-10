/**
 * The single owner of compile-pipeline caching and orchestration.
 *
 * Before this module, "how does compilation caching work" required reading
 * four places: parseCache.ts (parse memo), commands.ts (three module
 * globals + compileMany + ensureCompiledClosure), precompile.ts (config
 * grouping + cross-config assert), and the directory branch of compile().
 * A BuildSession now owns all of that state and logic; commands.ts keeps
 * thin delegates for its existing exports.
 *
 * Contract (spec "Boundary constraints"): buildCompiledClosure remains a
 * pure exported function — compileSource (lib/compiler/compile.ts) calls
 * it directly for in-memory sandbox compiles and must not be affected.
 *
 * PR 2 adds `freshness`/the manifest here. Until then every compile is a
 * full compile (the historical behavior).
 */
import { AgencyConfig } from "@/config.js";
import { AgencyProgram, generateTypeScript } from "@/index.js";
import { initPlanForModule } from "@/backends/typescriptGenerator.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { resolveReExports } from "@/preprocessors/resolveReExports.js";
import { liftCallbackBlocks } from "@/preprocessors/liftCallbacks.js";
import { buildCompilationUnit, CompilationUnit } from "@/compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatErrors, typeCheck } from "@/typeChecker/index.js";
import {
  agencyImportTargets,
  buildCompiledClosure,
  CompileClosureError,
  programHasPkgImport,
  type CompiledClosure,
} from "@/compiler/compileClosure.js";
import {
  createManifestTracker,
  NOOP_TRACKER,
  type Freshness,
  type ManifestTracker,
} from "./manifestTracker.js";
import { deriveConfigKey } from "./buildManifest.js";
import { transformSync } from "esbuild";
import * as fs from "fs";
import * as path from "path";
import {
  getStdlibDir,
  isNonTemplatedStdlib,
  isPkgImport,
  isStdlibImport,
  resolveAgencyImportPath,
} from "@/importPaths.js";
import { CompileStrategy, type ImportStrategy } from "@/importStrategy.js";
import { parseAgencyFileCached } from "@/parseCache.js";
import { findRecursively, getImports } from "@/cli/util.js";

export type CompileOptions = {
  ts?: boolean;
  symbolTable?: SymbolTable;
  importStrategy?: ImportStrategy;
  /** Suppress the per-file `input → output (in Nms)` progress line. */
  quiet?: boolean;
  /** Test-harness only. Honors `import test { … }`. Never set outside the
   *  test runner / analysis paths — kept off AgencyConfig so agent source
   *  cannot enable it. */
  allowTestImports?: boolean;
  /** Skip policy. "incremental" (default) consults and records the
   *  manifest; "force" recompiles everything but rewrites it (--force);
   *  "always" is internal (allowTestImports / --ts / caller-supplied
   *  importStrategy) and touches nothing. */
  freshness?: Freshness;
};

export type CompileRequest = {
  /** Files or directories. One entry = the legacy per-entry path
   *  (covers-check closure, stdlib carve-out); many = one union closure. */
  entries: string[];
  /** Single non-directory entry only: explicit output path. */
  outputFile?: string;
} & CompileOptions;

/**
 * A set of entry files sharing one effective config. The canonical config
 * key is NOT part of this type: it is the session's own integrity
 * mechanism (the cross-config assert compares it, and PR 2 makes it a
 * manifest field), so the session derives it — a caller-supplied key that
 * canonicalized differently would silently weaken the assert.
 */
export type CompileGroup = {
  /** Base-config marker or the local-`agency.json` dir, for error messages. */
  label: string;
  config: AgencyConfig;
  /** Absolute `.agency` entry paths. */
  files: string[];
};

// The only place freshness OVERRIDES live; the policy MEANING lives in
// the tracker factory. A caller-supplied importStrategy shapes emitted
// bytes (RunStrategy rewrites .ts import specifiers and transpiles
// sibling .ts deps on disk — run/runAgencyNode/coverage paths), and the
// manifest key cannot see it — same disease configKey/hasPkgImports
// prevent, so it forces "always".
function resolveFreshness(
  options?: CompileOptions & { outputFile?: string },
): Freshness {
  // An explicit outputFile also forces "always": a fresh entry only knows
  // the RECORDED output path, so a skip could return the requested path
  // without ever writing it. Unreachable today (the only outputFile caller
  // also passes RunStrategy) but both are public surface — same precedent
  // as --ts: different artifact, not manifest-tracked.
  if (
    options?.allowTestImports ||
    options?.ts ||
    options?.importStrategy ||
    options?.outputFile !== undefined
  ) {
    return "always";
  }
  return options?.freshness ?? "incremental";
}

export function createBuildSession(): BuildSession {
  return new BuildSession();
}

export class BuildSession {
  private compiledFiles: Set<string> = new Set();
  // Cached `CompiledClosure` for this session. Built once at the outermost
  // compile call and reused by every per-file emit.
  private currentClosure: CompiledClosure | null = null;
  // Per-operation manifest policy object; NOOP outside operations and for
  // "always" sessions, so every call site is an unconditional one-liner.
  private tracker: ManifestTracker = NOOP_TRACKER;

  /**
   * The one public compile entry point: callers declare WHAT to build
   * (entries + options); the session decides how. A single entry keeps the
   * legacy per-entry closure semantics (covers-check reuse, stdlib
   * carve-out); multiple entries compile under ONE union closure, where
   * closure errors THROW (`CompileClosureError`) so programmatic callers
   * can attach context. Parse/typecheck failures inside per-file compiles
   * keep their exit behavior. Returns the output path for a single
   * non-directory entry, null otherwise.
   */
  compile(config: AgencyConfig, request: CompileRequest): string | null {
    const { entries, outputFile, ...options } = request;
    if (outputFile !== undefined && entries.length !== 1) {
      throw new Error("outputFile is only valid with a single file entry");
    }
    if (entries.length === 0) {
      return null;
    }
    this.tracker = createManifestTracker(config, entries[0], resolveFreshness(request));
    try {
      // Fully-clean fast path: every requested module fresh per the
      // manifest alone — no closure walk, no parsing. Directories expand
      // with the same walker the compile path uses.
      const { files: allFiles, hasDirectory } = expandEntries(entries);
      if (this.tracker.allFresh(allFiles)) {
        for (const file of allFiles) {
          this.compiledFiles.add(file);
        }
        if (!options.quiet) {
          console.log(`${allFiles.length} file(s) up to date`);
        }
        // Match the compile path contract: directory entries return null
        // even when the directory holds exactly one file.
        if (allFiles.length === 1 && !hasDirectory) {
          return this.tracker.outputFor(allFiles[0]);
        }
        return null;
      }
      if (entries.length === 1) {
        return this.compileEntry(config, entries[0], outputFile, options);
      }
      this.compileManyImpl(config, entries, options);
      return null;
    } finally {
      // Modules emitted before a later failure are legitimately fresh, so
      // flushing in finally is correct. Caveat: most compile failures are
      // process.exit(1), which bypasses finally — the flush is simply
      // lost, which only over-rebuilds next time. Safe.
      this.tracker.flush();
      this.tracker = NOOP_TRACKER;
    }
  }

  /** Compile config-heterogeneous groups (one union closure each), after
   *  asserting no module is reachable from groups whose configs differ —
   *  compiled output is config-dependent and a sibling `.js` is a single
   *  slot per module, so a shared module would be last-writer-wins.
   *  Throws `CompileClosureError` naming the module and group labels. */
  compileGroups(
    groups: CompileGroup[],
    options?: { quiet?: boolean; allowTestImports?: boolean; freshness?: Freshness },
  ): void {
    const withClosures = groups.map((group) => ({
      group,
      configKey: deriveConfigKey(group.config),
      closure: buildCompiledClosure(group.files, group.config),
    }));

    const conflicts = findCrossConfigConflicts(
      withClosures.map(({ group, configKey, closure }) => ({
        label: group.label,
        configKey,
        modules: Object.keys(closure.programs),
      })),
    );
    if (conflicts.length > 0) {
      const lines = conflicts.map(
        (c) =>
          `  ${c.module}\n    reachable from: ${c.labels.join(", ")}`,
      );
      throw new CompileClosureError(
        "Test sources with differing configs share modules. A module's " +
          "compiled .js is a single slot, so this would be last-writer-wins. " +
          "Move the shared module or align the configs:\n" +
          lines.join("\n"),
      );
    }

    for (const { group, closure } of withClosures) {
      // Each group gets its own tracker (per-group config identity); the
      // test runner passes allowTestImports, which resolves to "always"
      // and the NOOP tracker — no manifest IO, structurally.
      this.tracker = createManifestTracker(group.config, group.files[0], resolveFreshness(options));
      try {
        this.compileManyImpl(group.config, group.files, {
          closure,
          quiet: options?.quiet,
          allowTestImports: options?.allowTestImports,
        });
      } finally {
        this.tracker.flush();
        this.tracker = NOOP_TRACKER;
      }
    }
  }

  /** Drop all cached state (watch-mode rebuild boundary). */
  reset(): void {
    this.setClosure(null);
    this.tracker = NOOP_TRACKER;
  }

  // `compiledFiles` entries are only meaningful under the current closure,
  // so replacing the closure MUST clear the set. Previously that pairing
  // was enforced by hand at three separate call sites; this makes it
  // structural (and protects the additional writers PR 2 introduces).
  private setClosure(closure: CompiledClosure | null): void {
    this.currentClosure = closure;
    this.compiledFiles.clear();
  }

  /** BFS over the closure import graph. Stdlib entries have no closure —
   *  their deps are [] by construction (stdlibHash covers them). */
  private transitiveDeps(absModule: string): string[] {
    const programs = this.currentClosure?.programs;
    if (!programs || !programs[absModule]) {
      return [];
    }
    const seen = [absModule];
    for (let i = 0; i < seen.length; i++) {
      const program = programs[seen[i]];
      if (!program) {
        continue;
      }
      for (const target of agencyImportTargets(program, seen[i])) {
        if (!seen.includes(target)) {
          seen.push(target);
        }
      }
    }
    return seen.slice(1);
  }

  /**
   * Internal variant of compileMany keeping the prebuilt-closure handoff
   * (`options.closure`) used by compileGroups; the public method omits it —
   * the closure MUST cover every file, a cache-coherence contract no
   * external caller should have to carry.
   */
  private compileManyImpl(
    config: AgencyConfig,
    files: string[],
    options?: CompileOptions & {
      /** Prebuilt union closure (compileGroups handoff). MUST cover every
       *  file, or the covers-check clears the session cache mid-loop. */
      closure?: CompiledClosure;
    },
  ): void {
    const absFiles = files.map((f) => path.resolve(f));
    if (absFiles.length === 0) {
      return;
    }
    const { closure, ...compileOptions } = options ?? {};
    this.setClosure(closure ?? buildCompiledClosure(absFiles, config));
    for (const file of absFiles) {
      this.compileEntry(config, file, undefined, compileOptions);
    }
  }

  /**
   * Build the import-closure analysis once per compile session — at the
   * outermost call, before any recursive per-file compile runs. The
   * recursive children reuse the cached closure to get per-module init
   * plans without re-parsing.
   *
   * "Outermost call" = no `options.symbolTable` (passed by recursive
   * children). When the outermost call's entry file changes (e.g. the
   * `agency test` runner iterates several .test.json fixtures in one
   * process), the cached closure no longer covers the new entry's
   * imports so we rebuild and drop the stale `compiledFiles` set.
   * Without that drop, downstream codegen would look up plans for
   * modules that aren't in the closure and emit an empty init plan.
   *
   * Stdlib files compile under their own entry (e.g., when a user runs
   * `agency compile std/...`) but most user code reaches them via
   * `import "std::..."`, which the closure walker intentionally skips.
   * Avoid building a closure rooted at a stdlib file — its imports are
   * structured differently and we don't need the analysis there.
   */
  private ensureCompiledClosure(
    absoluteInputFile: string,
    config: AgencyConfig,
    hasSymbolTable: boolean,
    verbose: boolean,
  ): void {
    const isOutermostCall = !hasSymbolTable;
    const isStdlibEntry = absoluteInputFile.startsWith(getStdlibDir() + path.sep);
    const closureCoversEntry =
      this.currentClosure?.programs[absoluteInputFile] !== undefined;
    if (!isOutermostCall || isStdlibEntry || closureCoversEntry) return;

    this.setClosure(null);
    try {
      const ccStartTime = performance.now();
      this.setClosure(buildCompiledClosure(absoluteInputFile, config));
      const ccEndTime = performance.now();
      logTime({ label: "Built compile closure", start: ccStartTime, end: ccEndTime, verbose });
    } catch (e) {
      if (e instanceof CompileClosureError) {
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
  }

  // A directory is many entry points — every .agency file under it. To
  // avoid recompiling shared dependencies once per entry, build ONE
  // import closure covering all of them up front and reuse it for every
  // file. Without this, each sibling entry the previous closure didn't
  // cover would clear the per-session cache (see ensureCompiledClosure)
  // and recompile shared deps once per entry. Skipped for:
  //   - recursive child calls (a symbolTable was threaded in) — those
  //     aren't real top-level directory compiles; and
  //   - stdlib dirs, which intentionally compile without a closure (the
  //     same carve-out ensureCompiledClosure makes for stdlib entries).
  private compileDirectory(
    config: AgencyConfig,
    inputFile: string,
    options?: CompileOptions,
  ): null {
    const files = [...findRecursively(inputFile)].map((f) => f.path);
    const absDir = path.resolve(inputFile);
    const isStdlibDir =
      absDir === getStdlibDir() || absDir.startsWith(getStdlibDir() + path.sep);
    if (!options?.symbolTable && !isStdlibDir && files.length > 0) {
      try {
        // The fresh union closure supersedes anything cached for a prior
        // entry (setClosure drops the per-file set so codegen reruns under
        // the new closure).
        this.setClosure(
          buildCompiledClosure(
            files.map((f) => path.resolve(f)),
            config,
          ),
        );
      } catch (e) {
        if (e instanceof CompileClosureError) {
          console.error(e.message);
          process.exit(1);
        }
        throw e;
      }
    }
    for (const file of files) {
      this.compileEntry(config, file, undefined, options);
    }
    return null;
  }

  private compileEntry(
    config: AgencyConfig,
    inputFile: string,
    _outputFile?: string,
    options?: CompileOptions,
  ): string | null {
    if (!fs.existsSync(inputFile)) {
      console.error(`Error: Input file '${inputFile}' not found`);
      process.exit(1);
    }
    const stats = fs.statSync(inputFile);
    const verbose = config.verbose ?? false;
    if (stats.isDirectory()) {
      return this.compileDirectory(config, inputFile, options);
    }

    const compileStartTime = performance.now();
    const absoluteInputFile = path.resolve(inputFile);

    const ext = options?.ts ? ".ts" : ".js";
    // Anchor the replacement to the extension so that an absolute path
    // containing ".agency" as a substring in a parent directory (e.g.
    // "/Users/me/dev/worksy.agency-init/src/agent.agency") does not get
    // the first match clobbered. See issue #48.
    let outputFile = _outputFile || inputFile.replace(/\.agency$/, ext);
    if (config.outDir && !_outputFile) {
      const outputDir = path.resolve(config.outDir);

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      outputFile = path.join(outputDir, outputFile);
    }
    if (this.compiledFiles.has(absoluteInputFile)) {
      return outputFile;
    }

    // Incremental skip — BEFORE the closure build, so a fresh module pays
    // no parse, no analysis, no typecheck, no recursion into imports (its
    // depsHash covers the whole subtree), no emit. The NOOP tracker makes
    // this constant-false for "always" sessions. Deliberately NOT added to
    // compiledFiles here: ensureCompiledClosure below may clear that set,
    // and repeat visits are absorbed by this same check.
    if (this.tracker.isFresh(absoluteInputFile)) {
      return outputFile;
    }

    this.ensureCompiledClosure(absoluteInputFile, config, !!options?.symbolTable, verbose);

    // Added AFTER ensureCompiledClosure: setClosure clears the dedupe set
    // when the closure changes, so an earlier add would be wiped moments
    // later (this ordering predates the manifest and must be preserved).
    this.compiledFiles.add(absoluteInputFile);

    const contents = readFile(inputFile);
    const applyTemplate = !isNonTemplatedStdlib(absoluteInputFile);
    const parsedProgram = parseFileOrExit(absoluteInputFile, config, applyTemplate, contents);

    const symbolTableStartTime = performance.now();
    const symbolTable =
      options?.symbolTable ?? SymbolTable.build(absoluteInputFile, config);

    const symbolTableEndTime = performance.now();
    logTime({ label: `Built symbol table for ${absoluteInputFile}`, start: symbolTableStartTime, end: symbolTableEndTime, verbose });

    const compilationUnitStartTime = performance.now();
    const reExportedProgram = resolveReExports(
      parsedProgram,
      symbolTable,
      absoluteInputFile,
    );
    const resolvedProgram = resolveImports(reExportedProgram, symbolTable, absoluteInputFile, {
      allowTestImports: options?.allowTestImports ?? false,
    });
    // Lift `callback("onX") { ... }` block bodies to top-level defs.
    // Must run BEFORE buildCompilationUnit and typecheck so the lifted defs
    // appear in functionDefinitions and get their bodies typechecked.
    const liftedProgram = liftCallbackBlocks(resolvedProgram);
    const info = buildCompilationUnit(
      liftedProgram,
      symbolTable,
      absoluteInputFile,
      contents,
    );
    const compilationUnitEndTime = performance.now();
    logTime({ label: `Built compilation unit for ${absoluteInputFile}`, start: compilationUnitStartTime, end: compilationUnitEndTime, verbose });

    runTypecheck(liftedProgram, config, info, absoluteInputFile, verbose);

    const imports = getImports(resolvedProgram);

    for (const importPath of imports) {
      if (isStdlibImport(importPath) || isPkgImport(importPath)) continue;

      const absPath = resolveAgencyImportPath(importPath, absoluteInputFile);
      this.compileEntry(config, absPath, undefined, { ...options, symbolTable });
    }

    // Rewrite import paths in the AST using the import strategy
    const strategy =
      options?.importStrategy ?? new CompileStrategy({ targetExt: ".js" });
    const nonAgencyImports: string[] = [];

    liftedProgram.nodes.forEach((node) => {
      if (node.type !== "importStatement") return;
      if (isStdlibImport(node.modulePath) || isPkgImport(node.modulePath)) return;

      node.modulePath = strategy.rewriteImport(
        node.modulePath,
        absoluteInputFile,
      );

      if (!node.modulePath.endsWith(".agency")) {
        nonAgencyImports.push(node.modulePath);
      }
    });

    try {
      strategy.prepareDependencies(nonAgencyImports, absoluteInputFile);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    const moduleId = path.relative(process.cwd(), absoluteInputFile);
    const absoluteOutputFile = path.resolve(outputFile);
    // Per-module init plan view — derived from the cached closure if we
    // built one. Modules not in the closure (e.g., out-of-tree stdlib
    // compiles) fall through to the legacy path with no plan.
    const initPlan = this.currentClosure
      ? initPlanForModule(this.currentClosure, absoluteInputFile)
      : undefined;
    const codegenStartTime = performance.now();
    const generatedCode = generateTypeScript(
      liftedProgram,
      config,
      info,
      moduleId,
      absoluteOutputFile,
      initPlan,
    );
    const codegenEndTime = performance.now();
    logTime({ label: `Generated code for ${absoluteInputFile}`, start: codegenStartTime, end: codegenEndTime, verbose });
    if (options?.ts) {
      fs.writeFileSync(outputFile, "// @ts-nocheck\n" + generatedCode, "utf-8");
    } else {
      const esbuildStartTime = performance.now();
      const result = transformSync(generatedCode, {
        loader: "ts",
        format: "esm",
        supported: { "top-level-await": true },
      });
      fs.writeFileSync(outputFile, result.code, "utf-8");
      const esbuildEndTime = performance.now();
      logTime({ label: `Transformed code for ${absoluteInputFile} with esbuild`, start: esbuildStartTime, end: esbuildEndTime, verbose });
      // Record ONLY when the module's deps are knowable: covered by the
      // session closure, or a stdlib module (compiled closure-free by
      // design; deps [] is correct because stdlibHash covers all of
      // stdlib). A module compiled with a caller-threaded symbolTable and
      // no closure (agency serve) has REAL imports the session cannot see
      // — recording deps: [] would poison the manifest with an entry that
      // skips despite edited imports.
      const isStdlibModule = absoluteInputFile.startsWith(getStdlibDir() + path.sep);
      const depsKnowable =
        isStdlibModule || this.currentClosure?.programs[absoluteInputFile] !== undefined;
      if (depsKnowable) {
        const transitiveDeps = this.transitiveDeps(absoluteInputFile);
        this.tracker.record(
          absoluteInputFile,
          path.resolve(outputFile),
          transitiveDeps,
          subtreeHasPkgImport(this.currentClosure, absoluteInputFile, transitiveDeps),
        );
      }
    }
    const compileEndTime = performance.now();
    const timeTaken = `${(compileEndTime - compileStartTime).toFixed(2)}ms`
    if (!options?.quiet) {
      console.log(`${inputFile} → ${outputFile} (in ${timeTaken})`);
    }
    return outputFile;
  }
}

export function readFile(inputFile: string): string {
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file '${inputFile}' not found`);
    process.exit(1);
  }

  return fs.readFileSync(inputFile, "utf-8");
}

export function findCrossConfigConflicts(
  groups: { label: string; configKey: string; modules: string[] }[],
): { module: string; labels: string[] }[] {
  // Null-prototype: keyed by absolute module paths.
  const touchedBy: Record<string, { configKey: string; label: string }[]> =
    Object.create(null);
  for (const group of groups) {
    for (const module of group.modules) {
      (touchedBy[module] ??= []).push({
        configKey: group.configKey,
        label: group.label,
      });
    }
  }
  const conflicts: { module: string; labels: string[] }[] = [];
  for (const [module, touches] of Object.entries(touchedBy)) {
    const distinctKeys = touches
      .map((t) => t.configKey)
      .filter((key, i, all) => all.indexOf(key) === i);
    if (distinctKeys.length > 1) {
      conflicts.push({ module, labels: touches.map((t) => t.label) });
    }
  }
  return conflicts;
}

// Cached-parse counterpart of `parse()`: same exit-on-failure contract the
// CLI pipeline expects, but reads through the process-wide parse cache.
function parseFileOrExit(
  absPath: string,
  config: AgencyConfig,
  applyTemplate: boolean,
  contents: string,
): AgencyProgram {
  const parseResult = parseAgencyFileCached(absPath, config, applyTemplate);
  if (!parseResult.success) {
    if (parseResult.message) {
      console.error(`Failed to parse Agency program: ${parseResult.message}`);
    } else {
      console.error("Failed to parse Agency program.", contents.slice(0, 400));
    }
    process.exit(1);
  }
  return parseResult.result;
}

function runTypecheck(
  liftedProgram: AgencyProgram,
  config: AgencyConfig,
  info: CompilationUnit,
  absoluteInputFile: string,
  verbose: boolean,
): void {
  const tc = config.typechecker;
  if (!tc?.enabled && !tc?.strict) return;
  const tcStartTime = performance.now();
  const { errors } = typeCheck(liftedProgram, config, info);
  const tcEndTime = performance.now();
  logTime({ label: `Type checked ${absoluteInputFile}`, start: tcStartTime, end: tcEndTime, verbose });
  if (errors.length === 0) return;
  if (tc?.strict) {
    console.error(formatErrors(errors));
    const hasFatal = errors.some((e) => (e.severity ?? "error") === "error");
    if (hasFatal) process.exit(1);
  } else {
    console.warn(formatErrors(errors, "warning"));
  }
}

function logTime({ label, start, end, verbose }: { label: string, start: number, end: number, verbose: boolean }): void {
  if (verbose) {
    console.log(`${label} in ${(end - start).toFixed(2)}ms`);
  }
}

/** pkg:: imports are invisible to the closure and depsHash; a module whose
 *  subtree touches pkg:: is never skipped (spec). Edge detection is shared
 *  with the closure walker via programHasPkgImport. */
function subtreeHasPkgImport(
  closure: CompiledClosure | null,
  absModule: string,
  transitiveDeps: string[],
): boolean {
  for (const modulePath of [absModule, ...transitiveDeps]) {
    const program = closure?.programs[modulePath];
    if (program && programHasPkgImport(program)) {
      return true;
    }
  }
  return false;
}

/** Expand request entries to absolute FILE paths: directories via the same
 *  walker the compile path uses, files as-is. Fast-path support only —
 *  the compile dispatch itself keeps its dir handling untouched. */
function expandEntries(entries: string[]): { files: string[]; hasDirectory: boolean } {
  const files: string[] = [];
  let hasDirectory = false;
  for (const entry of entries) {
    if (fs.existsSync(entry) && fs.statSync(entry).isDirectory()) {
      hasDirectory = true;
      for (const found of findRecursively(entry)) {
        files.push(path.resolve(found.path));
      }
    } else {
      files.push(path.resolve(entry));
    }
  }
  return { files, hasDirectory };
}
