/**
 * Validates the transitive import closure of untrusted Agency source before
 * sandboxed compilation. The one invariant that carries the sandbox safety
 * guarantee: the closure contains nothing but Agency source and std::
 * imports. TypeScript/JavaScript files, node builtins, pkg:: packages that
 * reach either, and compile-time splices are all refused — splices BEFORE
 * anything could expand them, because splice generators execute in the
 * compiling process, outside the sandbox.
 *
 * The result is an opaque capability: only `compileValidatedClosure`
 * (lib/compiler/compileValidatedClosure.ts) may open it, so the mirror
 * protocol (module ids, relPaths, rewrite locations) stays private to the
 * compiler subsystem.
 */
import * as fs from "fs";
import * as path from "path";
import { nanoid } from "nanoid";
import { parseAgency } from "@/parser.js";
import { getAllImports } from "@/analysis/imports.js";
import {
  findPackageRoot,
  importKind,
  parsePkgImport,
  resolveAgencyImportPath,
} from "@/importPaths.js";
import { splicesIn } from "@/preprocessors/expandSplices.js";
import { isStrictDescendant } from "@/utils.js";
import type { SourceLocation } from "@/types/base.js";
import type { AgencyProgram } from "@/types.js";

declare const validatedClosureBrand: unique symbol;
export type ValidatedClosure = {
  readonly [validatedClosureBrand]: true;
};

type LocalImportEdge = {
  fromModuleId: string;
  importPath: string;
  toModuleId: string;
  /** Location of the path characters in the importing file (quotes excluded). */
  modulePathLoc: SourceLocation;
};

type ValidatedModule = {
  source: string;
  relPath: string;
};

type ValidatedClosureData = {
  /** realpath of dir, or null when dir was "": no local root, so any local
   *  import anywhere in the closure is a validation error. "" is never
   *  resolved to the current working directory. */
  root: string | null;
  /** Module id → validated content. File ids are realpaths; a string entry
   *  uses a private generated id. relPaths are POSIX, relative to root. */
  modules: Record<string, ValidatedModule>;
  /** Caller-root local edges only. Package-local edges are validated under
   *  the package root, then deliberately omitted: pkg files are the
   *  documented trusted re-read boundary (node_modules is already-trusted
   *  executable content). */
  localEdges: LocalImportEdge[];
  entryModuleId: string;
  pkgModules: string[];
  /** Caller-level pkg imports resolve via createRequire from the importing
   *  file; the mirror has no node_modules, so compilation needs each
   *  package's validated real root to link under the mirror. */
  pkgAnchors: { packageName: string; packageRoot: string }[];
};

export class ClosureValidationError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`Sandboxed compilation refused:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
    this.name = "ClosureValidationError";
    this.violations = violations;
  }
}

export type SourceClosureEntry = { source: string };
export type FileClosureEntry = { file: string };
export type ClosureEntry = SourceClosureEntry | FileClosureEntry;
export type ValidateClosureArgs = {
  entry: ClosureEntry;
  dir: string;
};

/** Compiler-internal accessor. Not a package export; only the sandboxed
 *  compile path may open the capability. */
export function openValidatedClosure(closure: ValidatedClosure): ValidatedClosureData {
  return closure as unknown as ValidatedClosureData;
}

/** Test-only projection: names and counts, never mutable source, canonical
 *  ids, byte locations, or mirror layout. */
export function snapshotValidatedClosureForTest(closure: ValidatedClosure): {
  root: string | null;
  moduleRelativePaths: string[];
  localEdgeCount: number;
  pkgModules: string[];
} {
  const data = openValidatedClosure(closure);
  return {
    root: data.root,
    moduleRelativePaths: Object.values(data.modules).map((m) => m.relPath),
    localEdgeCount: data.localEdges.length,
    pkgModules: data.pkgModules,
  };
}

type WalkContext = {
  /** Confinement boundary for local imports resolved from this file. */
  root: string | null;
  /** Caller-root files are collected for the mirror; package files are not. */
  collect: boolean;
};

/** The recursive walk and its accumulators, extracted so validateClosure
 *  stays a short orchestration: resolve the root, walk the entry, throw
 *  or freeze. */
class ClosureWalker {
  readonly violations: string[] = [];
  readonly modules: Record<string, ValidatedModule> = {};
  readonly localEdges: LocalImportEdge[] = [];
  readonly pkgModules: string[] = [];
  readonly pkgAnchors: { packageName: string; packageRoot: string }[] = [];
  private readonly visited: Record<string, true> = {};
  /** Local imports written in the string entry resolve against the root,
   *  as if the entry sat at the root itself. */
  readonly virtualEntryBase: string | null;

  constructor(root: string | null) {
    this.virtualEntryBase = root === null ? null : path.join(root, "__virtual_entry__.agency");
  }

  walkParsed(
    moduleId: string,
    filePath: string | null,
    program: AgencyProgram,
    ctx: WalkContext,
  ): void {
    const label = filePath ?? "<entry source>";
    if (splicesIn(program).length > 0) {
      this.violations.push(
        `${label} contains a compile-time splice, which sandboxed compilation refuses`,
      );
    }
    for (const imp of getAllImports(program)) {
      const kind = importKind(imp.path);
      if (kind === "stdlib") continue;
      if (kind === "node") {
        this.violations.push(
          `${label} imports '${imp.path}', which is not Agency source (Node/JS modules are not allowed in sandboxed code)`,
        );
        continue;
      }
      if (kind === "pkg") {
        this.walkPackage(imp.path, filePath ?? this.virtualEntryBase ?? entryBaseForPkg(), ctx);
        continue;
      }
      this.walkLocalImport(moduleId, label, filePath, imp, ctx);
    }
  }

  private walkLocalImport(
    moduleId: string,
    label: string,
    filePath: string | null,
    imp: { path: string; pathLoc?: SourceLocation },
    ctx: WalkContext,
  ): void {
    if (!imp.path.endsWith(".agency")) {
      this.violations.push(
        `${label} imports '${imp.path}', which is not Agency source (only .agency files may be imported in sandboxed code)`,
      );
      return;
    }
    if (ctx.root === null) {
      this.violations.push(
        `${label} imports '${imp.path}', but there is no sandbox dir to resolve local imports against (pass dir)`,
      );
      return;
    }
    const base = filePath === null ? (this.virtualEntryBase as string) : filePath;
    const resolved = path.resolve(path.dirname(base), imp.path);
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
    } catch (e) {
      this.violations.push(`${label}: import '${imp.path}' cannot be read: ${messageOf(e)}`);
      return;
    }
    if (!isStrictDescendant(ctx.root, canonical)) {
      this.violations.push(
        `${label}: import '${imp.path}' resolves to '${canonical}', which is outside the sandbox dir '${ctx.root}'`,
      );
      return;
    }
    if (ctx.collect) {
      if (imp.pathLoc === undefined) {
        this.violations.push(
          `${label}: internal diagnostic — parsed import '${imp.path}' carries no module-path location`,
        );
        return;
      }
      this.localEdges.push({
        fromModuleId: moduleId,
        importPath: imp.path,
        toModuleId: canonical,
        modulePathLoc: imp.pathLoc,
      });
    }
    this.walkFile(canonical, ctx, label);
  }

  walkFile(canonical: string, ctx: WalkContext, importedFrom: string): void {
    if (this.visited[canonical]) return;
    this.visited[canonical] = true;
    let source: string;
    try {
      source = fs.readFileSync(canonical, "utf-8");
    } catch (e) {
      this.violations.push(`${importedFrom}: '${canonical}' cannot be read: ${messageOf(e)}`);
      return;
    }
    const parsed = parseAgency(source, {}, false);
    if (!parsed.success) {
      this.violations.push(
        `${canonical} failed to parse: ${parsed.message ?? "unknown parse error"}`,
      );
      return;
    }
    if (ctx.collect && ctx.root !== null) {
      this.modules[canonical] = {
        source,
        relPath: toPosixRelPath(ctx.root, canonical),
      };
    }
    this.walkParsed(canonical, canonical, parsed.result, ctx);
  }

  private walkPackage(pkgPath: string, fromFile: string, ctx: WalkContext): void {
    let resolved: string;
    try {
      resolved = resolveAgencyImportPath(pkgPath, fromFile);
    } catch (e) {
      this.violations.push(`import '${pkgPath}' cannot be resolved: ${messageOf(e)}`);
      return;
    }
    const { packageName } = parsePkgImport(pkgPath);
    let pkgRootReal: string;
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
      // The package's confinement boundary is its NAMED root. Nearest
      // package.json is wrong: a nested one (a module-type boundary inside
      // the package) would become the anchor, and the mirror's
      // node_modules/<name> link would point at the subdirectory, so a
      // subpath import resolves twice-nested and fails.
      pkgRootReal = findPackageRoot(path.dirname(canonical), packageName);
    } catch (e) {
      this.violations.push(`import '${pkgPath}' cannot be read: ${messageOf(e)}`);
      return;
    }
    if (!this.pkgModules.includes(pkgPath)) this.pkgModules.push(pkgPath);
    // Only caller-level imports compile from the mirror and need an anchor;
    // package-internal pkg imports resolve from the real package files.
    if (ctx.collect) {
      const existing = this.pkgAnchors.find((a) => a.packageName === packageName);
      if (existing === undefined) {
        this.pkgAnchors.push({ packageName, packageRoot: pkgRootReal });
      } else if (existing.packageRoot !== pkgRootReal) {
        this.violations.push(
          `package '${packageName}' resolves to two different installations ` +
            `('${existing.packageRoot}' and '${pkgRootReal}'), which sandboxed compilation cannot mirror`,
        );
        return;
      }
    }
    this.walkFile(canonical, { root: pkgRootReal, collect: false }, `pkg import '${pkgPath}'`);
  }
}

// Only pkg resolution from a string entry with no dir needs SOME anchor:
// createRequire walks node_modules upward from it. The invoking process's
// cwd is the natural anchor there (matching where the process would
// resolve its own dependencies); local imports never use this.
function entryBaseForPkg(): string {
  return path.join(process.cwd(), "__virtual_entry__.agency");
}

export function validateClosure(args: ValidateClosureArgs): ValidatedClosure {
  let root: string | null = null;
  if (args.dir !== "") {
    try {
      root = fs.realpathSync(path.resolve(args.dir));
    } catch (e) {
      throw new ClosureValidationError([
        `sandbox dir '${args.dir}' cannot be resolved: ${messageOf(e)}`,
      ]);
    }
  }

  const walker = new ClosureWalker(root);
  const callerCtx: WalkContext = { root, collect: true };

  let entryModuleId: string;
  if ("file" in args.entry) {
    if (root === null) {
      throw new ClosureValidationError([
        `a file entry ('${args.entry.file}') requires a sandbox dir`,
      ]);
    }
    const resolved = path.resolve(root, args.entry.file);
    // Refuse an escaping entry BEFORE reading it: lexical containment first,
    // realpath containment after.
    if (!isStrictDescendant(root, resolved) && resolved !== root) {
      throw new ClosureValidationError([
        `entry '${args.entry.file}' resolves to '${resolved}', which is outside the sandbox dir '${root}'`,
      ]);
    }
    try {
      entryModuleId = fs.realpathSync(resolved);
    } catch (e) {
      throw new ClosureValidationError([
        `entry '${args.entry.file}' cannot be read: ${messageOf(e)}`,
      ]);
    }
    if (!isStrictDescendant(root, entryModuleId)) {
      throw new ClosureValidationError([
        `entry '${args.entry.file}' resolves to '${entryModuleId}', which is outside the sandbox dir '${root}'`,
      ]);
    }
    walker.walkFile(entryModuleId, callerCtx, `entry '${args.entry.file}'`);
  } else {
    entryModuleId = `<entry:${nanoid()}>`;
    const parsed = parseAgency(args.entry.source, {}, false);
    if (!parsed.success) {
      throw new ClosureValidationError([
        `entry source failed to parse: ${parsed.message ?? "unknown parse error"}`,
      ]);
    }
    walker.modules[entryModuleId] = {
      source: args.entry.source,
      relPath: pickEntryRelPath(),
    };
    walker.walkParsed(entryModuleId, null, parsed.result, callerCtx);
  }

  if (walker.violations.length > 0) {
    throw new ClosureValidationError(walker.violations);
  }

  // The entry relPath must not collide with any real module's relPath.
  const entryModule = walker.modules[entryModuleId];
  if (entryModule !== undefined && "source" in args.entry) {
    const taken = Object.entries(walker.modules)
      .filter(([id]) => id !== entryModuleId)
      .map(([, m]) => m.relPath);
    while (taken.includes(entryModule.relPath)) {
      entryModule.relPath = pickEntryRelPath();
    }
  }

  const data: ValidatedClosureData = Object.freeze({
    root,
    modules: walker.modules,
    localEdges: walker.localEdges,
    entryModuleId,
    pkgModules: walker.pkgModules,
    pkgAnchors: walker.pkgAnchors,
  });
  return data as unknown as ValidatedClosure;
}

function pickEntryRelPath(): string {
  return `__entry_${nanoid(8)}__.agency`;
}

function toPosixRelPath(root: string, canonical: string): string {
  return path.relative(root, canonical).split(path.sep).join(path.posix.sep);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
