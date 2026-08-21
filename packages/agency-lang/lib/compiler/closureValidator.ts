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
import { importKind, resolveAgencyImportPath } from "@/importPaths.js";
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

export function validateClosure(args: ValidateClosureArgs): ValidatedClosure {
  const violations: string[] = [];
  const modules: Record<string, ValidatedModule> = {};
  const localEdges: LocalImportEdge[] = [];
  const pkgModules: string[] = [];
  const visited: Record<string, true> = {};

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

  // Resolve local imports written in the string entry against the root, as
  // if the entry sat at the root itself.
  const virtualEntryBase = root === null ? null : path.join(root, "__virtual_entry__.agency");

  const walkParsed = (
    moduleId: string,
    filePath: string | null,
    source: string,
    program: AgencyProgram,
    ctx: WalkContext,
  ): void => {
    const label = filePath ?? "<entry source>";
    if (splicesIn(program).length > 0) {
      violations.push(
        `${label} contains a compile-time splice, which sandboxed compilation refuses`,
      );
    }
    for (const imp of getAllImports(program)) {
      const kind = importKind(imp.path);
      if (kind === "stdlib") continue;
      if (kind === "node") {
        violations.push(
          `${label} imports '${imp.path}', which is not Agency source (Node/JS modules are not allowed in sandboxed code)`,
        );
        continue;
      }
      if (kind === "pkg") {
        walkPackage(imp.path, filePath ?? virtualEntryBase ?? entryBaseForPkg());
        continue;
      }
      // kind === "local"
      if (!imp.path.endsWith(".agency")) {
        violations.push(
          `${label} imports '${imp.path}', which is not Agency source (only .agency files may be imported in sandboxed code)`,
        );
        continue;
      }
      if (ctx.root === null) {
        violations.push(
          `${label} imports '${imp.path}', but there is no sandbox dir to resolve local imports against (pass dir)`,
        );
        continue;
      }
      const base = filePath === null ? (virtualEntryBase as string) : filePath;
      const resolved = path.resolve(path.dirname(base), imp.path);
      let canonical: string;
      try {
        canonical = fs.realpathSync(resolved);
      } catch (e) {
        violations.push(`${label}: import '${imp.path}' cannot be read: ${messageOf(e)}`);
        continue;
      }
      if (!isStrictDescendant(ctx.root, canonical)) {
        violations.push(
          `${label}: import '${imp.path}' resolves to '${canonical}', which is outside the sandbox dir '${ctx.root}'`,
        );
        continue;
      }
      if (ctx.collect) {
        if (imp.pathLoc === undefined) {
          violations.push(
            `${label}: internal diagnostic — parsed import '${imp.path}' carries no module-path location`,
          );
          continue;
        }
        localEdges.push({
          fromModuleId: moduleId,
          importPath: imp.path,
          toModuleId: canonical,
          modulePathLoc: imp.pathLoc,
        });
      }
      walkFile(canonical, ctx, label);
    }
  };

  const walkFile = (canonical: string, ctx: WalkContext, importedFrom: string): void => {
    if (visited[canonical]) return;
    visited[canonical] = true;
    let source: string;
    try {
      source = fs.readFileSync(canonical, "utf-8");
    } catch (e) {
      violations.push(`${importedFrom}: '${canonical}' cannot be read: ${messageOf(e)}`);
      return;
    }
    const parsed = parseAgency(source, {}, false);
    if (!parsed.success) {
      violations.push(`${canonical} failed to parse: ${parsed.message ?? "unknown parse error"}`);
      return;
    }
    if (ctx.collect && ctx.root !== null) {
      modules[canonical] = {
        source,
        relPath: toPosixRelPath(ctx.root, canonical),
      };
    }
    walkParsed(canonical, canonical, source, parsed.result, ctx);
  };

  const walkPackage = (pkgPath: string, fromFile: string): void => {
    let resolved: string;
    try {
      resolved = resolveAgencyImportPath(pkgPath, fromFile);
    } catch (e) {
      violations.push(`import '${pkgPath}' cannot be resolved: ${messageOf(e)}`);
      return;
    }
    let pkgRootReal: string;
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
      pkgRootReal = path.dirname(canonical);
      // The package's confinement boundary is its own root: walk up to the
      // directory holding package.json.
      let probe = pkgRootReal;
      while (!fs.existsSync(path.join(probe, "package.json"))) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      pkgRootReal = probe;
    } catch (e) {
      violations.push(`import '${pkgPath}' cannot be read: ${messageOf(e)}`);
      return;
    }
    if (!pkgModules.includes(pkgPath)) pkgModules.push(pkgPath);
    walkFile(canonical, { root: pkgRootReal, collect: false }, `pkg import '${pkgPath}'`);
  };

  // Only pkg resolution from a string entry with no dir needs SOME anchor:
  // createRequire walks node_modules upward from it. The invoking process's
  // cwd is the natural anchor there (matching where the process would
  // resolve its own dependencies); local imports never use this.
  const entryBaseForPkg = (): string => path.join(process.cwd(), "__virtual_entry__.agency");

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
    walkFile(entryModuleId, callerCtx, `entry '${args.entry.file}'`);
  } else {
    entryModuleId = `<entry:${nanoid()}>`;
    const source = args.entry.source;
    const parsed = parseAgency(source, {}, false);
    if (!parsed.success) {
      throw new ClosureValidationError([
        `entry source failed to parse: ${parsed.message ?? "unknown parse error"}`,
      ]);
    }
    modules[entryModuleId] = {
      source,
      relPath: pickEntryRelPath(),
    };
    walkParsed(entryModuleId, null, source, parsed.result, callerCtx);
  }

  if (violations.length > 0) {
    throw new ClosureValidationError(violations);
  }

  // The entry relPath must not collide with any real module's relPath.
  const entryModule = modules[entryModuleId];
  if (entryModule !== undefined && "source" in args.entry) {
    const taken = Object.entries(modules)
      .filter(([id]) => id !== entryModuleId)
      .map(([, m]) => m.relPath);
    while (taken.includes(entryModule.relPath)) {
      entryModule.relPath = pickEntryRelPath();
    }
  }

  const data: ValidatedClosureData = Object.freeze({
    root,
    modules,
    localEdges,
    entryModuleId,
    pkgModules,
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
