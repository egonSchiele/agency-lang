/**
 * Validates the transitive import closure of untrusted Agency source before
 * sandboxed compilation. The one invariant that carries the sandbox safety
 * guarantee: the closure contains nothing but Agency source and std::
 * imports. TypeScript/JavaScript files, node builtins, pkg:: packages, and
 * compile-time splices are all refused — splices BEFORE anything could
 * expand them, because splice generators execute in the compiling process,
 * outside the sandbox.
 *
 * Local imports must be regular files inside `dir`, reached without any
 * symlink. That rule is what lets the mirror (compileValidatedClosure.ts)
 * lay every file out at its own relative path and compile it unchanged:
 * a file's relative imports resolve identically in the mirror.
 *
 * Trusted modules (docs/dev/runtime/trusted-modules.md) are the one place
 * the "Agency source only" rule stops. An import that resolves under a
 * trusted `source` directory still has to be a `.agency` file inside `dir`,
 * reached without a symlink, and its compiled file must exist. Past that,
 * nothing it imports is checked: it and every `.agency` file reachable from
 * it are read only so the mirror can hold them for the typechecker and the
 * closure builder. They are marked `trusted` and never compiled; the child
 * imports the host's compiled file instead.
 *
 * The result is an opaque capability. Compiler-side source preparation and
 * compilation may inspect it; runtime code receives only compiled output.
 */
import * as fs from "fs";
import { rootPath } from "../host/roots.js";
import * as path from "path";
import { nanoid } from "nanoid";
import { parseAgency } from "@/parser.js";
import { getAllImports } from "@/analysis/imports.js";
import { importKind } from "@/importPaths.js";
import { splicesIn } from "@/preprocessors/expandSplices.js";
import { isStrictDescendant } from "@/utils.js";
// The synchronous file operations of nodeHost, not host.files: the compiler
// has no run to take a host from.
import { root, readText } from "@/host/node/nodeFiles.js";
import type { AgencyProgram } from "@/types.js";
import { compiledPathFor, trustedEntryFor, type TrustedModules } from "./trustedModules.js";

declare const validatedClosureBrand: unique symbol;
export type ValidatedClosure = {
  readonly [validatedClosureBrand]: true;
};

type ValidatedModule = {
  source: string;
  /** POSIX path relative to root; where the mirror writes the file. */
  relPath: string;
  /** True for a trusted module and every `.agency` file reachable from
   *  one: mirrored for the typechecker, never compiled. */
  trusted: boolean;
  /** Each import specifier this module writes that resolved to a trusted
   *  module, mapped to that module's absolute compiled path. The compiler
   *  rewrites those imports to these paths. */
  trustedImports: Record<string, string>;
};

type ValidatedClosureData = {
  /** realpath of dir, or null when dir was "": no local root, so any local
   *  import anywhere in the closure is a validation error. "" is never
   *  resolved to the current working directory. */
  root: string | null;
  /** Module id → validated content. File ids are absolute paths; a string
   *  entry uses a private generated id. */
  modules: Record<string, ValidatedModule>;
  entryModuleId: string;
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
  /** Resolved trusted modules (real paths). Absent or empty: every import
   *  is checked, as before trusted modules existed. */
  trustedModules?: TrustedModules[];
};

/** Compiler-internal accessor for validated source preparation and compilation.
 * Not a package export. */
export function openValidatedClosure(closure: ValidatedClosure): ValidatedClosureData {
  return closure as unknown as ValidatedClosureData;
}

/** Add a compiler-generated adapter without reopening any validated source.
 * Its local imports must name files already in the snapshot. */
export function withGeneratedEntry(closure: ValidatedClosure, source: string): ValidatedClosure {
  const data = openValidatedClosure(closure);
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success || splicesIn(parsed.result).length > 0) {
    throw new ClosureValidationError(["The generated entry must be Agency source without splices"]);
  }
  const paths = Object.values(data.modules).map((module) => module.relPath);
  for (const imported of getAllImports(parsed.result)) {
    if (importKind(imported.path) === "stdlib") continue;
    const relative = path.posix.normalize(imported.path);
    if (path.isAbsolute(imported.path) || !paths.includes(relative)) {
      throw new ClosureValidationError([
        `Generated entry imports '${imported.path}', which is outside the validated closure`,
      ]);
    }
  }
  const entryModuleId = `<adapter:${nanoid()}>`;
  let relPath = pickEntryRelPath();
  while (paths.includes(relPath)) relPath = pickEntryRelPath();
  return Object.freeze({
    ...data,
    entryModuleId,
    modules: {
      ...data.modules,
      [entryModuleId]: { source, relPath, trusted: false, trustedImports: {} },
    },
  }) as unknown as ValidatedClosure;
}

/** Test-only projection: names only, never source or mirror layout. */
export function snapshotValidatedClosureForTest(closure: ValidatedClosure): {
  root: string | null;
  moduleRelativePaths: string[];
  trustedRelativePaths: string[];
  trustedImports: Record<string, Record<string, string>>;
} {
  const data = openValidatedClosure(closure);
  const modules = Object.values(data.modules);
  return {
    root: data.root,
    moduleRelativePaths: modules.map((m) => m.relPath),
    trustedRelativePaths: modules.filter((m) => m.trusted).map((m) => m.relPath),
    trustedImports: Object.fromEntries(
      modules
        .filter((m) => Object.keys(m.trustedImports).length > 0)
        .map((m) => [m.relPath, m.trustedImports]),
    ),
  };
}

/** The recursive walk and its accumulators, extracted so validateClosure
 *  stays a short orchestration: resolve the root, walk the entry, throw
 *  or freeze. */
class ClosureWalker {
  readonly violations: string[] = [];
  readonly modules: Record<string, ValidatedModule> = {};
  /** Files walked with the rules applied. */
  private readonly validated: Record<string, true> = {};
  /** Files walked as mirror-only (trusted). A file reached here first and
   *  later by a validated import is walked again with the rules, and is
   *  then compiled like any other validated file. */
  private readonly mirrored: Record<string, true> = {};
  /** Local imports written in the string entry resolve against the root,
   *  as if the entry sat at the root itself. */
  private readonly virtualEntryBase: string | null;

  constructor(
    private readonly root: string | null,
    private readonly trusted: TrustedModules[],
  ) {
    this.virtualEntryBase = root === null ? null : path.join(root, "__virtual_entry__.agency");
  }

  walkParsed(filePath: string | null, program: AgencyProgram, importer: ValidatedModule): void {
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
        this.violations.push(
          `${label} imports '${imp.path}'; pkg:: imports are not supported in sandboxed code`,
        );
        continue;
      }
      this.walkLocalImport(label, filePath, imp.path, importer);
    }
  }

  private walkLocalImport(
    label: string,
    filePath: string | null,
    importPath: string,
    importer: ValidatedModule,
  ): void {
    if (!importPath.endsWith(".agency")) {
      this.violations.push(
        `${label} imports '${importPath}', which is not Agency source (only .agency files may be imported in sandboxed code)`,
      );
      return;
    }
    if (this.root === null) {
      this.violations.push(
        `${label} imports '${importPath}', but there is no sandbox dir to resolve local imports against (pass dir)`,
      );
      return;
    }
    // An absolute path would resolve to the ORIGINAL file from inside the
    // mirror, reopening the validate-then-reread window the mirror closes.
    if (path.isAbsolute(importPath)) {
      this.violations.push(
        `${label} imports '${importPath}' by absolute path; sandboxed imports must be relative`,
      );
      return;
    }
    const base = filePath === null ? (this.virtualEntryBase as string) : filePath;
    const resolved = path.resolve(path.dirname(base), importPath);
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
    } catch (e) {
      this.violations.push(`${label}: import '${importPath}' cannot be read: ${messageOf(e)}`);
      return;
    }
    const trustedEntry = trustedEntryFor(canonical, this.trusted);
    if (trustedEntry !== null) {
      this.walkTrustedImport(label, importPath, resolved, canonical, trustedEntry, importer);
      return;
    }
    if (!isStrictDescendant(this.root, canonical)) {
      this.violations.push(
        `${label}: import '${importPath}' resolves to '${canonical}', which is outside the sandbox dir '${this.root}'`,
      );
      return;
    }
    // The root is already a realpath and every walked file is reached by
    // its real path, so any difference here means a symlink somewhere in
    // the import's own path. Refused rather than followed: the mirror
    // copies files at their written paths and does not reproduce links.
    // (readText re-checks this on the opened descriptor, so a
    // link swapped in after this point is refused too.)
    if (canonical !== resolved) {
      this.violations.push(
        `${label}: import '${importPath}' goes through a symlink ('${resolved}' is really '${canonical}'); sandboxed imports must be regular files`,
      );
      return;
    }
    this.walkFile(canonical, label);
  }

  /** The trust branch of walkLocalImport. The import keeps the rules that
   *  let the mirror place it (inside `dir`, no symlink) and must have a
   *  compiled file; then its specifier is recorded for the rewrite and the
   *  module is mirrored without checking what it imports. */
  private walkTrustedImport(
    label: string,
    importPath: string,
    resolved: string,
    canonical: string,
    entry: TrustedModules,
    importer: ValidatedModule,
  ): void {
    const root = this.root as string;
    if (!isStrictDescendant(root, canonical)) {
      this.violations.push(
        `${label}: import '${importPath}' resolves to '${canonical}', which is outside the sandbox dir '${root}'`,
      );
      return;
    }
    if (canonical !== resolved) {
      this.violations.push(
        `${label}: import '${importPath}' goes through a symlink ('${resolved}' is really '${canonical}'); sandboxed imports must be regular files`,
      );
      return;
    }
    const compiled = this.compiledFileFor(label, importPath, canonical, entry);
    if (compiled === null) return;
    importer.trustedImports[importPath] = compiled;
    this.walkMirroredFile(canonical, label);
  }

  /** The compiled file for a trusted module, or null after recording a
   *  violation when it is missing. Checked here, before anything runs, so a
   *  missing build fails the compile with the path it looked for. */
  compiledFileFor(
    label: string,
    importPath: string,
    canonical: string,
    entry: TrustedModules,
  ): string | null {
    const compiled = compiledPathFor(canonical, entry);
    if (!isRegularFile(compiled)) {
      this.violations.push(
        `${label} imports '${importPath}', a trusted module whose compiled file '${compiled}' does not exist; build it first`,
      );
      return null;
    }
    return compiled;
  }

  walkFile(filePath: string, importedFrom: string): void {
    if (this.validated[filePath]) return;
    this.validated[filePath] = true;
    const program = this.readModule(filePath, importedFrom, false);
    if (program === null) return;
    this.walkParsed(filePath, program, this.modules[filePath]);
  }

  /** Mirror a trusted module, or a file reachable from one: read, parse,
   *  record as trusted, and follow its `.agency` imports the same way. No
   *  rule applies. Imports that are not `.agency`, and `std::` and `pkg::`
   *  imports, are ignored: not refused, not followed. A file outside `dir`
   *  is a violation only because the mirror cannot place it. */
  walkMirroredFile(filePath: string, importedFrom: string): void {
    if (this.validated[filePath] || this.mirrored[filePath]) return;
    this.mirrored[filePath] = true;
    const root = this.root as string;
    if (!isStrictDescendant(root, filePath)) {
      this.violations.push(
        `${importedFrom}: '${filePath}', imported by a trusted module, is outside the sandbox dir '${root}', so the sandbox cannot mirror it for the typechecker`,
      );
      return;
    }
    const program = this.readModule(filePath, importedFrom, true);
    if (program === null) return;
    for (const imp of getAllImports(program)) {
      if (importKind(imp.path) !== "local" || !imp.path.endsWith(".agency")) continue;
      if (path.isAbsolute(imp.path)) continue;
      this.walkMirroredFile(path.resolve(path.dirname(filePath), imp.path), filePath);
    }
  }

  /** Read and parse one file under the root and record it. Null after
   *  recording a violation. */
  private readModule(
    filePath: string,
    importedFrom: string,
    trusted: boolean,
  ): AgencyProgram | null {
    let source: string;
    try {
      const sandbox = root(this.root as string);
      source = readText(sandbox, path.relative(rootPath(sandbox), filePath));
    } catch (e) {
      this.violations.push(`${importedFrom}: '${filePath}' cannot be read: ${messageOf(e)}`);
      return null;
    }
    const parsed = parseAgency(source, {}, false);
    if (!parsed.success) {
      this.violations.push(
        `${filePath} failed to parse: ${parsed.message ?? "unknown parse error"}`,
      );
      return null;
    }
    this.modules[filePath] = {
      source,
      relPath: toPosixRelPath(this.root as string, filePath),
      trusted,
      trustedImports: {},
    };
    return parsed.result;
  }
}

function isRegularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
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

  const walker = new ClosureWalker(root, args.trustedModules ?? []);

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
    if (entryModuleId !== resolved) {
      throw new ClosureValidationError([
        `entry '${args.entry.file}' goes through a symlink ('${resolved}' is really '${entryModuleId}'); sandboxed files must be regular files`,
      ]);
    }
    // A trusted module as the entry is the `describe` case: it is read for
    // its signatures and mirrored, never checked or compiled.
    const label = `entry '${args.entry.file}'`;
    const trustedEntry = trustedEntryFor(entryModuleId, args.trustedModules ?? []);
    if (trustedEntry === null) {
      walker.walkFile(entryModuleId, label);
    } else if (
      walker.compiledFileFor(label, args.entry.file, entryModuleId, trustedEntry) !== null
    ) {
      walker.walkMirroredFile(entryModuleId, label);
    }
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
      trusted: false,
      trustedImports: {},
    };
    walker.walkParsed(null, parsed.result, walker.modules[entryModuleId]);
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
    entryModuleId,
  });
  return data as unknown as ValidatedClosure;
}

function pickEntryRelPath(): string {
  return `__entry_${nanoid(8)}__.agency`;
}

function toPosixRelPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join(path.posix.sep);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
