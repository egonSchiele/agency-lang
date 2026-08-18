import fs from "fs";
import path from "path";

import { buildSync } from "esbuild";

import {
  agencyImportTargets,
  nonAgencyLocalImportTargets,
  resolveAgencyImportPath,
} from "@/importPaths.js";
import { parseAgency } from "@/parser.js";
import type { AgencyProgram } from "@/types.js";

/** One file of an agent's .agency import closure, parsed exactly once.
 *  Two consumers: seeding reads only `absoluteFile`; the optimizer's target
 *  discovery reads `source` (content hashes for safe writeback) and
 *  `program` (finding optimize-marked declarations). */
export type ParsedSourceFile = {
  absoluteFile: string;
  source: string;
  program: AgencyProgram;
};

/** Walk the local .agency import closure of `absoluteEntryFile`, parsing each
 *  file once. The single parse pass target discovery and seeding both share. */
export function walkAgencyClosure(absoluteEntryFile: string): ParsedSourceFile[] {
  const parsedFiles: ParsedSourceFile[] = [];
  visitFile(absoluteEntryFile, {}, parsedFiles);
  return parsedFiles;
}

function visitFile(
  absoluteFile: string,
  visited: Record<string, true>,
  parsedFiles: ParsedSourceFile[],
): void {
  const canonicalFile = fs.realpathSync(absoluteFile);
  if (visited[canonicalFile]) return;
  visited[canonicalFile] = true;

  const source = fs.readFileSync(canonicalFile, "utf8");
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) {
    throw new Error(`Failed to parse ${canonicalFile}: ${parseResult.message ?? "parse error"}`);
  }

  parsedFiles.push({ absoluteFile: canonicalFile, source, program: parseResult.result });

  for (const importPath of agencyImportTargets(parseResult.result, { localOnly: true })) {
    visitFile(resolveAgencyImportPath(importPath, canonicalFile), visited, parsedFiles);
  }
}

/** Absolute base directory a closure's relative paths hang off: the files'
 *  common ancestor, unless that lies inside the current working directory, in
 *  which case cwd wins. */
export function closureBaseDir(absoluteFiles: string[]): string {
  const ancestor = commonAncestor(absoluteFiles.map((file) => path.dirname(file)));
  const cwd = fs.realpathSync(process.cwd());
  return isInsideOrSame(ancestor, cwd) ? cwd : ancestor;
}

export function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return process.cwd();
  const [first, ...rest] = paths.map((candidate) => path.resolve(candidate).split(path.sep));
  const prefix: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (rest.some((candidate) => candidate[index] !== segment)) break;
    prefix.push(segment);
  }
  const joined = prefix.join(path.sep);
  return joined === "" ? path.sep : joined;
}

function isInsideOrSame(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The entry file's full local closure: every .agency file the walk reaches,
 *  plus the transitive local TS/JS files their interop imports need. baseDir
 *  is computed from the .agency files only, so adding TS deps can never
 *  shift it. */
export function agentClosure(entryFile: string): { baseDir: string; files: string[] } {
  const absoluteEntryFile = fs.realpathSync(path.resolve(entryFile));
  const parsedFiles = walkAgencyClosure(absoluteEntryFile);

  const agencyFiles = parsedFiles.map((parsed) => parsed.absoluteFile);
  const interopEntries = parsedFiles.flatMap((parsed) =>
    nonAgencyLocalImportTargets(parsed.program).map((specifier) =>
      resolveInteropEntry(path.dirname(parsed.absoluteFile), specifier),
    ),
  );
  const interopFiles = interopEntries.flatMap((interopEntry) => transitiveTsFiles(interopEntry));

  const files = uniqueSorted([...agencyFiles, ...interopFiles].sort());
  return { baseDir: closureBaseDir(agencyFiles), files };
}

/** `./greet.js` on disk may be greet.ts (the guide says to write .js even for
 *  TypeScript sources). Prefer the file that exists; .ts when both do not. */
function resolveInteropEntry(fromDir: string, specifier: string): string {
  const asWritten = path.resolve(fromDir, specifier);
  if (fs.existsSync(asWritten)) return asWritten;
  const asTs = asWritten.replace(/\.js$/, ".ts");
  if (fs.existsSync(asTs)) return asTs;
  return asWritten; // let esbuild produce the resolution error, which names the importer
}

/** The transitive local file set of one TS/JS entry, from esbuild's metafile.
 *  Bare (package) imports stay external, so only relative files appear. */
function transitiveTsFiles(interopEntry: string): string[] {
  const result = buildSync({
    entryPoints: [interopEntry],
    bundle: true,
    write: false,
    metafile: true,
    packages: "external",
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs).map((inputPath) => path.resolve(inputPath));
}

/** Remove duplicates from a sorted list (equal items are adjacent). Dupes
 *  arise when two .agency files import the same TS helper, or two TS entries
 *  share transitive files. */
function uniqueSorted(sorted: string[]): string[] {
  return sorted.filter((item, index) => index === 0 || item !== sorted[index - 1]);
}

export function agentClosureBaseDir(entryFile: string): string {
  return agentClosure(entryFile).baseDir;
}
