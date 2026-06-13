import crypto from "crypto";
import fs from "fs";
import path from "path";
import { agencyImportTargets, resolveAgencyImportPath } from "@/importPaths.js";
import { parseAgency } from "@/parser.js";
import type { AgencyNode, AgencyProgram, Assignment, PromptSegment } from "@/types.js";
import { expressionToString, walkNodes } from "@/utils/node.js";

export type OptimizeTarget = {
  id: string;
  kind: "variable";
  file: string;
  absoluteFile: string;
  scope: string;
  name: string;
  valueKind: "string" | "multilineString";
  value: string;
};

export type OptimizeSourceFile = {
  file: string;
  absoluteFile: string;
  source: string;
  sha256: string;
};

export type OptimizeTargetSet = {
  baseDir: string;
  entryFile: string;
  files: Record<string, OptimizeSourceFile>;
  targets: OptimizeTarget[];
};

export type DiscoverOptimizeTargetsOptions = {
  baseDir?: string;
};

/** A discovered target paired with its `Assignment` node in the parsed
 *  program, for consumers (like the source mutator) that edit the AST. */
export type OptimizeTargetNode = {
  target: OptimizeTarget;
  assignment: Assignment;
};

export function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Discovers optimize targets across the local Agency import closure of
 * `entryFile`. This is the single parse pass over the closure: when
 * `options.baseDir` is omitted, the base/working directory is computed from
 * the walked closure itself (its common ancestor directory, unless that
 * lies inside the current working directory, in which case cwd wins) — so
 * callers never need a second closure walk to pick a working dir.
 */
export function discoverOptimizeTargets(
  entryFile: string,
  options: DiscoverOptimizeTargetsOptions = {},
): OptimizeTargetSet {
  const absoluteEntryFile = fs.realpathSync(path.resolve(entryFile));
  const parsedFiles: ParsedSourceFile[] = [];
  visitFile(absoluteEntryFile, {}, parsedFiles);

  const baseDir = options.baseDir
    ? fs.realpathSync(path.resolve(options.baseDir))
    : defaultBaseDir(parsedFiles.map((parsed) => parsed.absoluteFile));

  const files: Record<string, OptimizeSourceFile> = {};
  const targets: OptimizeTarget[] = [];
  for (const parsed of parsedFiles) {
    const file = relativeFile(baseDir, parsed.absoluteFile);
    files[file] = {
      file,
      absoluteFile: parsed.absoluteFile,
      source: parsed.source,
      sha256: sha256Text(parsed.source),
    };
    rejectLegacyOptimizeTags(parsed.program, file);
    targets.push(...collectTargets(parsed.program, file, parsed.absoluteFile).map((entry) => entry.target));
  }

  targets.sort((a, b) => a.id.localeCompare(b.id));
  rejectDuplicateTargetIds(targets);

  return {
    baseDir,
    entryFile: relativeFile(baseDir, absoluteEntryFile),
    files,
    targets,
  };
}

type ParsedSourceFile = {
  absoluteFile: string;
  source: string;
  program: AgencyProgram;
};

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
    throw new Error(`Failed to parse optimize target file ${canonicalFile}: ${parseResult.message ?? "parse error"}`);
  }

  parsedFiles.push({ absoluteFile: canonicalFile, source, program: parseResult.result });

  for (const importPath of agencyImportTargets(parseResult.result, { localOnly: true })) {
    visitFile(resolveAgencyImportPath(importPath, canonicalFile), visited, parsedFiles);
  }
}

function defaultBaseDir(absoluteFiles: string[]): string {
  const ancestor = commonAncestor(absoluteFiles.map((file) => path.dirname(file)));
  const cwd = fs.realpathSync(process.cwd());
  return isInsideOrSame(ancestor, cwd) ? cwd : ancestor;
}

function commonAncestor(paths: string[]): string {
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

/**
 * Collects the optimize targets declared in one parsed program, paired with
 * their `Assignment` nodes. Discovery uses the target halves; the source
 * mutator uses the assignment nodes to replace initializers and this same
 * function to refresh target entries after rendering a candidate.
 */
export function collectTargets(
  program: AgencyProgram,
  file: string,
  absoluteFile: string,
): OptimizeTargetNode[] {
  const collected: OptimizeTargetNode[] = [];
  for (const { node, ancestors } of walkNodes(program.nodes)) {
    if (node.type !== "assignment" || !node.optimize) continue;

    const scope = directOptimizeScope(ancestors);
    if (!scope) {
      throw new Error(
        `Optimize declarations inside nested block scopes are unsupported in v1. Move ${file}:${node.variableName} to the top level of the function or node body.`,
      );
    }

    collected.push({ target: buildTarget(node, file, absoluteFile, scope), assignment: node });
  }
  return collected;
}

function directOptimizeScope(ancestors: AgencyNode[]): string | null {
  if (ancestors.length === 0) return "global";
  if (ancestors.length !== 1) return null;
  const parent = ancestors[0];
  if (parent.type === "function") return parent.functionName;
  if (parent.type === "graphNode") return parent.nodeName;
  return null;
}

function buildTarget(
  assignment: Assignment,
  file: string,
  absoluteFile: string,
  scope: string,
): OptimizeTarget {
  if (assignment.value.type !== "string" && assignment.value.type !== "multiLineString") {
    throw new Error(
      `Unsupported optimize target ${file}:${scope}:${assignment.variableName}. Only string and multiline string initializers are supported today.`,
    );
  }

  return {
    id: `${file}:${scope}:${assignment.variableName}`,
    kind: "variable",
    file,
    absoluteFile,
    scope,
    name: assignment.variableName,
    valueKind: assignment.value.type === "multiLineString" ? "multilineString" : "string",
    value: promptSegmentsToString(assignment.value.segments),
  };
}

function rejectDuplicateTargetIds(targets: OptimizeTarget[]): void {
  const seen: Record<string, true> = {};
  for (const target of targets) {
    if (seen[target.id]) {
      throw new Error(`Duplicate optimize target id ${target.id}. Each optimized variable must be unique within its file and scope.`);
    }
    seen[target.id] = true;
  }
}

function rejectLegacyOptimizeTags(program: AgencyProgram, file: string): void {
  for (const { node } of walkNodes(program.nodes)) {
    if (node.type === "tag" && node.name === "optimize") {
      throw legacyOptimizeError(file);
    }
    if ("tags" in node && Array.isArray(node.tags) && node.tags.some((tag) => tag.name === "optimize")) {
      throw legacyOptimizeError(file);
    }
  }
}

function legacyOptimizeError(file: string): Error {
  return new Error(
    `\`@optimize(...)\` is no longer supported in ${file}. Mark the declaration to optimize instead, for example:\n\n  optimize const prompt = "..."`,
  );
}

/**
 * Renders prompt segments back to the decoded target value representation:
 * literal text with interpolations re-rendered as `${expr}`. This is the
 * representation stored in `OptimizeTarget.value` and the one `expected`
 * guards compare against.
 */
export function promptSegmentsToString(segments: PromptSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.value;
    return `\${${expressionToString(segment.expression)}}`;
  }).join("");
}

function relativeFile(baseDir: string, absoluteFile: string): string {
  return path.relative(baseDir, absoluteFile).split(path.sep).join("/");
}
