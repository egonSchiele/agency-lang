import crypto from "crypto";
import fs from "fs";
import path from "path";
import { GLOBAL_SCOPE_KEY, buildCompilationUnit } from "@/compilationUnit.js";
import { agencyImportTargets, resolveAgencyImportPath } from "@/importPaths.js";
import { parseAgency } from "@/parser.js";
import { SymbolTable } from "@/symbolTable.js";
import type { AgencyNode, AgencyProgram, Assignment, PromptSegment, TypeAliasEntry, VariableType } from "@/types.js";
import { generateExpression } from "@/backends/agencyGenerator.js";
import { expressionToString, isLiteralExpression, walkNodes } from "@/utils/node.js";
import { checkProposal, renderDeclaredType } from "./constraint.js";

export type OptimizeTarget = {
  id: string;
  kind: "variable";
  file: string;
  absoluteFile: string;
  scope: string;
  name: string;
  valueKind: "string" | "multilineString" | "literal";
  /** Decoded text for text targets (interpolations rendered as `${...}` —
   *  the `expected`-guard contract); the EXACT source slice, quotes intact,
   *  for literal targets. */
  value: string;
  /** Parseable type text proposals are probed against (constraint.ts).
   *  `null` means FREEFORM for text targets (today's string-only semantics,
   *  interpolation rule and all) and UNCONSTRAINED for literal targets (any
   *  literal accepted). Consumers must branch on `valueKind` first. */
  declaredType: string | null;
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
  /** Global type aliases visible across the import closure, in the exact
   *  registry shape the typechecker consumes (`TypeAliasEntry`). Built by the
   *  compiler's own pipeline (SymbolTable + buildCompilationUnit), plain
   *  data — serializable. Consumed by the typed-target probe (constraint.ts). */
  typeAliases: Record<string, TypeAliasEntry>;
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
  return buildTargetSet(absoluteEntryFile, baseDir, parsedFiles);
}

/** Absolute base directory of `entryFile`'s local import closure — the seed
 *  directory for a run. Shared by the optimizer (as `source.baseDir`) and by
 *  plain eval, so both compute the same default seed when no explicit one is
 *  given. */
export function agentClosureBaseDir(entryFile: string): string {
  const absoluteEntryFile = fs.realpathSync(path.resolve(entryFile));
  const parsedFiles: ParsedSourceFile[] = [];
  visitFile(absoluteEntryFile, {}, parsedFiles);
  return defaultBaseDir(parsedFiles.map((parsed) => parsed.absoluteFile));
}

function buildTargetSet(
  absoluteEntryFile: string,
  baseDir: string,
  parsedFiles: ParsedSourceFile[],
): OptimizeTargetSet {
  const typeAliases = collectClosureTypeAliases(absoluteEntryFile, parsedFiles);

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
    targets.push(
      ...collectTargets(parsed.program, file, parsed.absoluteFile, typeAliases)
        .map((entry) => entry.target),
    );
  }

  targets.sort((a, b) => a.id.localeCompare(b.id));
  rejectDuplicateTargetIds(targets);

  return {
    baseDir,
    entryFile: relativeFile(baseDir, absoluteEntryFile),
    files,
    targets,
    typeAliases,
  };
}

/**
 * Global type aliases visible across the entry file's import closure, built
 * with the compiler's own pipeline (SymbolTable stitches imported/re-exported
 * aliases into the compilation unit) rather than a hand-rolled walk. Only the
 * global scope matters here: optimize targets constrain top-level literal
 * initializers, and the probe (constraint.ts) checks them in a synthetic
 * top-level program.
 */
function collectClosureTypeAliases(
  absoluteEntryFile: string,
  parsedFiles: ParsedSourceFile[],
): Record<string, TypeAliasEntry> {
  const entry = parsedFiles.find((parsed) => parsed.absoluteFile === fs.realpathSync(absoluteEntryFile));
  if (!entry) return {};
  // SymbolTable.build is stricter than this file's own closure walk: it
  // follows pkg:: imports and validates re-exported symbols, either of which
  // can throw on programs that discovery deliberately tolerates. A missing
  // registry only DEGRADES typed targets to unconstrained (via the baseline
  // self-test in constraint resolution) — it must never fail discovery.
  try {
    const symbolTable = SymbolTable.build(absoluteEntryFile);
    const unit = buildCompilationUnit(entry.program, symbolTable, entry.absoluteFile, entry.source);
    return nullPrototyped(unit.typeAliases.visibleIn(GLOBAL_SCOPE_KEY));
  } catch (error) {
    console.warn(
      `optimize discovery: could not build the type-alias registry for ${absoluteEntryFile} (typed targets will be unconstrained): ${error instanceof Error ? error.message : String(error)}`,
    );
    const unit = buildCompilationUnit(entry.program);
    return nullPrototyped(unit.typeAliases.visibleIn(GLOBAL_SCOPE_KEY));
  }
}

/** Null-prototype copy: the registry is keyed by user-defined type names, so
 *  a name like "__proto__" or "constructor" must land as a plain own
 *  property (same hardening as optimize/registry.ts and evalCache.ts). */
function nullPrototyped<T>(record: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null), record);
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
  typeAliases: Record<string, TypeAliasEntry>,
  priorTargets: Record<string, OptimizeTarget> = {},
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

    collected.push({
      target: buildTarget(node, file, absoluteFile, scope, typeAliases, priorTargets),
      assignment: node,
    });
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
  typeAliases: Record<string, TypeAliasEntry>,
  priorTargets: Record<string, OptimizeTarget>,
): OptimizeTarget {
  const value = assignment.value;
  if (value.type === "messageThread" || !isLiteralExpression(value)) {
    throw new Error(
      `Unsupported optimize target ${file}:${scope}:${assignment.variableName}. Its value must be a literal (string, number, boolean, null, object, or array).`,
    );
  }

  const id = `${file}:${scope}:${assignment.variableName}`;

  // A target's literal-vs-text identity and its constraint come from the
  // DECLARATION, decided once at discovery. On refresh collects (the source
  // mutator re-collecting after a mutation), the prior entry carries them:
  // re-deriving the identity from the champion's current value would let an
  // unconstrained literal target flip to freeform when a string value is
  // accepted, and re-running the baseline self-test would re-typecheck every
  // typed target on every preview. Within TEXT targets, the string /
  // multilineString sub-flavor DOES track the current value — it selects the
  // quote style unquoted proposals are recovered with.
  const prior = priorTargets[id];
  const isText = prior
    ? prior.valueKind !== "literal"
    : value.type === "string" || value.type === "multiLineString";
  const valueKind: OptimizeTarget["valueKind"] = !isText
    ? "literal"
    : value.type === "multiLineString"
      ? "multilineString"
      : "string";

  // Text targets keep the decoded representation (the `expected`-guard
  // contract). Literal targets carry formatter-exact source text, quotes
  // intact — parsed initializer nodes have no loc offsets to slice by.
  const valueSource = generateExpression(value);
  const valueText = isText && (value.type === "string" || value.type === "multiLineString")
    ? promptSegmentsToString(value.segments)
    : valueSource;

  if (!prior && !isText && !assignment.typeHint) {
    throw new Error(
      `Optimize target ${file}:${scope}:${assignment.variableName} is a non-string literal and needs a type annotation, e.g. \`optimize const ${assignment.variableName}: number = ${valueText}\`.`,
    );
  }

  return {
    id,
    kind: "variable",
    file,
    absoluteFile,
    scope,
    name: assignment.variableName,
    valueKind,
    value: valueText,
    declaredType: prior
      ? prior.declaredType
      : resolveDeclaredType(assignment.typeHint, valueSource, typeAliases),
  };
}

/**
 * The type text stored on a target, or null (freeform for text targets,
 * unconstrained for literal targets). Two rules beyond "use the annotation":
 * a plain `string` annotation is freeform, and the BASELINE SELF-TEST — if
 * the target's ORIGINAL initializer does not pass the probe against its own
 * annotation (unresolvable alias, exotic type, unrenderable annotation, a
 * pre-existing type warning the user tolerates), the target is unconstrained
 * so mutations are never blocked by a rule the baseline itself fails.
 */
function resolveDeclaredType(
  typeHint: VariableType | undefined,
  originalValueSource: string,
  typeAliases: Record<string, TypeAliasEntry>,
): string | null {
  if (!typeHint) return null;
  if (typeHint.type === "primitiveType" && typeHint.value === "string") return null;
  const text = renderDeclaredType(typeHint);
  if (!checkProposal(text, originalValueSource, typeAliases).ok) return null;
  return text;
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

/** A relpath→source map for a target set (e.g. the unchanged baseline file set). */
export function fileMap(source: OptimizeTargetSet): Record<string, string> {
  return Object.fromEntries(Object.entries(source.files).map(([rel, sf]) => [rel, sf.source]));
}
