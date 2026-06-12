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

export function discoverOptimizeTargets(
  entryFile: string,
  options: DiscoverOptimizeTargetsOptions = {},
): OptimizeTargetSet {
  const absoluteEntryFile = path.resolve(entryFile);
  const baseDir = fs.realpathSync(path.resolve(options.baseDir ?? process.cwd()));
  const files: Record<string, OptimizeSourceFile> = {};
  const targets: OptimizeTarget[] = [];
  const visited: Record<string, true> = {};

  visitFile(absoluteEntryFile, baseDir, visited, files, targets);

  targets.sort((a, b) => a.id.localeCompare(b.id));
  rejectDuplicateTargetIds(targets);

  return {
    baseDir,
    entryFile: relativeFile(baseDir, absoluteEntryFile),
    files,
    targets,
  };
}

function visitFile(
  absoluteFile: string,
  baseDir: string,
  visited: Record<string, true>,
  files: Record<string, OptimizeSourceFile>,
  targets: OptimizeTarget[],
): void {
  const canonicalFile = fs.realpathSync(absoluteFile);
  if (visited[canonicalFile]) return;
  visited[canonicalFile] = true;

  const source = fs.readFileSync(canonicalFile, "utf8");
  const file = relativeFile(baseDir, canonicalFile);
  const parseResult = parseAgency(source, {}, false);
  if (!parseResult.success) {
    throw new Error(`Failed to parse optimize target file ${file}: ${parseResult.message ?? "parse error"}`);
  }

  files[file] = {
    file,
    absoluteFile: canonicalFile,
    source,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
  };

  rejectLegacyOptimizeTags(parseResult.result, file);
  collectTargets(parseResult.result, file, canonicalFile, targets);

  for (const importPath of agencyImportTargets(parseResult.result, { localOnly: true })) {
    visitFile(resolveAgencyImportPath(importPath, canonicalFile), baseDir, visited, files, targets);
  }
}

function collectTargets(
  program: AgencyProgram,
  file: string,
  absoluteFile: string,
  targets: OptimizeTarget[],
): void {
  for (const { node, ancestors } of walkNodes(program.nodes)) {
    if (node.type !== "assignment" || !node.optimize) continue;

    const scope = directOptimizeScope(ancestors);
    if (!scope) {
      throw new Error(
        `Optimize declarations inside nested block scopes are unsupported in v1. Move ${file}:${node.variableName} to the top level of the function or node body.`,
      );
    }

    targets.push(buildTarget(node, file, absoluteFile, scope));
  }
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

function promptSegmentsToString(segments: PromptSegment[]): string {
  return segments.map((segment) => {
    if (segment.type === "text") return segment.value;
    return `\${${expressionToString(segment.expression)}}`;
  }).join("");
}

function relativeFile(baseDir: string, absoluteFile: string): string {
  return path.relative(baseDir, absoluteFile).split(path.sep).join("/");
}
