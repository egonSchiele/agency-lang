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
 * The result is an opaque capability: only `compileValidatedClosure` may
 * open it, so the mirror layout stays private to the compiler subsystem.
 */
import * as fs from "fs";
import * as path from "path";
import { nanoid } from "nanoid";
import { parseAgency } from "@/parser.js";
import { getAllImports } from "@/analysis/imports.js";
import { importKind } from "@/importPaths.js";
import { splicesIn } from "@/preprocessors/expandSplices.js";
import { isStrictDescendant } from "@/utils.js";
import type { AgencyProgram } from "@/types.js";

declare const validatedClosureBrand: unique symbol;
export type ValidatedClosure = {
  readonly [validatedClosureBrand]: true;
};

type ValidatedModule = {
  source: string;
  /** POSIX path relative to root; where the mirror writes the file. */
  relPath: string;
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
};

/** Compiler-internal accessor. Not a package export; only the sandboxed
 *  compile path may open the capability. */
export function openValidatedClosure(closure: ValidatedClosure): ValidatedClosureData {
  return closure as unknown as ValidatedClosureData;
}

/** Test-only projection: names only, never source or mirror layout. */
export function snapshotValidatedClosureForTest(closure: ValidatedClosure): {
  root: string | null;
  moduleRelativePaths: string[];
} {
  const data = openValidatedClosure(closure);
  return {
    root: data.root,
    moduleRelativePaths: Object.values(data.modules).map((m) => m.relPath),
  };
}

/** The recursive walk and its accumulators, extracted so validateClosure
 *  stays a short orchestration: resolve the root, walk the entry, throw
 *  or freeze. */
class ClosureWalker {
  readonly violations: string[] = [];
  readonly modules: Record<string, ValidatedModule> = {};
  private readonly visited: Record<string, true> = {};
  /** Local imports written in the string entry resolve against the root,
   *  as if the entry sat at the root itself. */
  private readonly virtualEntryBase: string | null;

  constructor(private readonly root: string | null) {
    this.virtualEntryBase = root === null ? null : path.join(root, "__virtual_entry__.agency");
  }

  walkParsed(filePath: string | null, program: AgencyProgram): void {
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
      this.walkLocalImport(label, filePath, imp.path);
    }
  }

  private walkLocalImport(label: string, filePath: string | null, importPath: string): void {
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
    if (canonical !== resolved) {
      this.violations.push(
        `${label}: import '${importPath}' goes through a symlink ('${resolved}' is really '${canonical}'); sandboxed imports must be regular files`,
      );
      return;
    }
    this.walkFile(canonical, label);
  }

  walkFile(filePath: string, importedFrom: string): void {
    if (this.visited[filePath]) return;
    this.visited[filePath] = true;
    let source: string;
    try {
      source = readRegularFile(filePath);
    } catch (e) {
      this.violations.push(`${importedFrom}: '${filePath}' cannot be read: ${messageOf(e)}`);
      return;
    }
    const parsed = parseAgency(source, {}, false);
    if (!parsed.success) {
      this.violations.push(
        `${filePath} failed to parse: ${parsed.message ?? "unknown parse error"}`,
      );
      return;
    }
    this.modules[filePath] = {
      source,
      relPath: toPosixRelPath(this.root as string, filePath),
    };
    this.walkParsed(filePath, parsed.result);
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

  const walker = new ClosureWalker(root);

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
    walker.walkFile(entryModuleId, `entry '${args.entry.file}'`);
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
    walker.walkParsed(null, parsed.result);
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

/** Reads a regular file through one descriptor: opened without following
 *  a final symlink and without blocking (so a FIFO returns instead of
 *  hanging the compiler), checked with fstat, then read from that same
 *  descriptor so nothing can be swapped between the check and the read. */
function readRegularFile(filePath: string): string {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(filePath, flags);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error("not a regular file");
    }
    return fs.readFileSync(fd, "utf-8");
  } finally {
    fs.closeSync(fd);
  }
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
