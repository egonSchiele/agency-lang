import * as fs from "fs";
import * as path from "path";

import { generateAgency } from "@/backends/agencyGenerator.js";
import { parseAgency, replaceBlankLines } from "@/parser.js";
import { exprParser } from "@/parsers/parsers.js";
import type { AgencyProgram, Expression, PromptSegment } from "@/types.js";
import { formatDiff } from "@/utils/diff.js";

import {
  collectTargets,
  promptSegmentsToString,
  sha256Text,
  type OptimizeSourceFile,
  type OptimizeTarget,
  type OptimizeTargetSet,
} from "./targets.js";
import { validateOptimizedStringValue } from "./validation.js";

/**
 * Replaces an optimized variable's initializer expression. `value` is
 * Agency source text including the quotes; `expected` optionally guards
 * against stale catalogs by matching the target's current decoded value.
 *
 * ```ts
 * { target: "foo.agency:bar:prompt", kind: "variable", op: "replaceInitializer",
 *   value: "\"new prompt\"", expected: "old prompt", rationale: "Clearer." }
 * ```
 */
export type ReplaceVariableInitializerOperation = {
  target: string;
  kind: "variable";
  op: "replaceInitializer";
  value: string;
  expected?: string;
  rationale?: string;
};

/**
 * Reserved for `optimize type` targets. Representable so LLM proposals can
 * carry it without a schema change when type support lands, but rejected by
 * validation in v1.
 */
export type ReplaceTypeDefinitionOperation = {
  target: string;
  kind: "type";
  op: "replaceTypeDefinition";
  value: string;
  expected?: string;
  rationale?: string;
};

/** One declarative source edit, discriminated by target kind. This is the
 *  shape LLM mutation proposals carry. */
export type OptimizeMutationOperation =
  | ReplaceVariableInitializerOperation
  | ReplaceTypeDefinitionOperation;

/**
 * A structured reason an operation was rejected, fed back into the mutator
 * prompt for the retry.
 *
 * ```ts
 * { target: "foo.agency:bar:prompt", code: "interpolation-mismatch",
 *   message: "you removed ${text} from the prompt" }
 * ```
 */
export type OptimizeMutationDiagnostic = {
  target?: string;
  code:
    | "unknown-target"
    | "kind-mismatch"
    | "unsupported-operation"
    | "expected-mismatch"
    | "invalid-replacement-syntax"
    | "unsupported-value-domain"
    | "interpolation-mismatch"
    | "duplicate-target-operation"
    | "parse-failed";
  message: string;
};

/**
 * The target-level record of one applied operation, with decoded old/new
 * values (no quotes), as written to `mutation.json`.
 *
 * ```ts
 * { target: "foo.agency:bar:prompt", kind: "variable", op: "replaceInitializer",
 *   oldValue: "old prompt", newValue: "new prompt", rationale: "Clearer." }
 * ```
 */
export type OptimizeAppliedChange = {
  target: string;
  kind: OptimizeMutationOperation["kind"];
  op: OptimizeMutationOperation["op"];
  oldValue: string;
  newValue: string;
  rationale?: string;
};

/**
 * The in-memory result of applying one operation batch: everything needed
 * to materialize, inspect, or reject a candidate without touching disk.
 *
 * ```ts
 * { files: { "foo.agency": "optimize const prompt = \"new\"\n..." },
 *   changes: [...OptimizeAppliedChange], diff: "--- foo.agency\n...",
 *   diagnostics: [], targetSet: {...updated catalog} }
 * ```
 */
export type OptimizeMutationPreview = {
  /** Full candidate file set (changed and unchanged discovered Agency files),
   *  keyed by relative path. Empty when `diagnostics` is non-empty. */
  files: Record<string, string>;
  changes: OptimizeAppliedChange[];
  diff: string;
  diagnostics: OptimizeMutationDiagnostic[];
  /** Target set for the candidate file set: changed entries refreshed, the
   *  rest carried over. Equals the input set when validation fails. */
  targetSet: OptimizeTargetSet;
};

/** A validated operation with its parsed replacement, ready to apply. */
type ResolvedOperation = {
  operation: ReplaceVariableInitializerOperation;
  target: OptimizeTarget;
  replacement: Expression & { segments: PromptSegment[] };
  newValue: string;
};

type ValidationOutcome =
  | { diagnostic: OptimizeMutationDiagnostic }
  | { resolved: ResolvedOperation };

/**
 * Applies declarative mutation operations to a discovered optimize target
 * set. Validation and rendering happen against the sources captured at
 * discovery time; nothing is read from disk. Batches are atomic: one invalid
 * operation means no files are produced.
 */
export class OptimizeSourceMutator {
  private readonly targetSet: OptimizeTargetSet;
  private readonly targetsById: Record<string, OptimizeTarget>;

  constructor(args: { targetSet: OptimizeTargetSet }) {
    this.targetSet = args.targetSet;
    this.targetsById = {};
    for (const target of args.targetSet.targets) {
      this.targetsById[target.id] = target;
    }
  }

  preview(operations: OptimizeMutationOperation[]): OptimizeMutationPreview {
    const { diagnostics, resolved } = this.validateOperations(operations);
    if (diagnostics.length > 0) return this.abortedPreview(diagnostics);
    return this.renderPreview(resolved);
  }

  /**
   * Shorthand over the operation API: infers the operation from the
   * discovered target kind. Unknown or unsupported target kinds are
   * rejected through diagnostics rather than guessed at.
   */
  mutate(target: string, value: string): OptimizeMutationPreview {
    const known = this.targetsById[target];
    if (!known) {
      return this.abortedPreview([{
        target,
        code: "unknown-target",
        message: `Unknown optimize target ${target}. Known targets: ${this.targetSet.targets.map((candidate) => candidate.id).join(", ")}`,
      }]);
    }
    return this.preview([operationForTarget(known, value)]);
  }

  /**
   * Writes a validated preview. With a destination directory, the full
   * candidate file set is written under it, preserving relative paths
   * (used to materialize `iter-N/agent/`). Without one, only changed
   * files are written back to their original source paths — callers own
   * any hash/staleness verification before asking for that.
   */
  apply(preview: OptimizeMutationPreview, destination?: string): void {
    if (preview.diagnostics.length > 0) {
      const details = preview.diagnostics
        .map((entry) => `- [${entry.code}] ${entry.message}`)
        .join("\n");
      throw new Error(`Cannot apply a preview with diagnostics:\n${details}`);
    }

    if (destination !== undefined) {
      for (const [file, source] of Object.entries(preview.files)) {
        writeFileEnsuringDir(path.join(destination, file), source);
      }
      return;
    }

    for (const [file, source] of Object.entries(preview.files)) {
      if (source === this.targetSet.files[file].source) continue;
      writeFileEnsuringDir(this.targetSet.files[file].absoluteFile, source);
    }
  }

  /**
   * Applies all resolved operations to in-memory parses of the touched
   * files, renders them, and round-trip-parses the rendered output to
   * refresh target entries. Only files named by operations are ever parsed
   * (2 parses each); everything else passes through as captured source.
   */
  private renderPreview(resolved: ResolvedOperation[]): OptimizeMutationPreview {
    const files: Record<string, string> = {};
    for (const [file, sourceFile] of Object.entries(this.targetSet.files)) {
      files[file] = sourceFile.source;
    }
    const updatedFiles: Record<string, OptimizeSourceFile> = { ...this.targetSet.files };
    let updatedTargets = [...this.targetSet.targets];
    const changes: OptimizeAppliedChange[] = [];
    const fileDiffs: string[] = [];

    const byFile: Record<string, ResolvedOperation[]> = {};
    for (const entry of resolved) {
      byFile[entry.target.file] = [...(byFile[entry.target.file] ?? []), entry];
    }

    for (const [file, fileOperations] of Object.entries(byFile)) {
      const sourceFile = this.targetSet.files[file];
      const outcome = this.renderFile(file, sourceFile, fileOperations);
      if ("diagnostic" in outcome) return this.abortedPreview([outcome.diagnostic]);

      files[file] = outcome.rendered;
      updatedFiles[file] = { ...sourceFile, source: outcome.rendered, sha256: sha256Text(outcome.rendered) };
      updatedTargets = updatedTargets
        .filter((target) => target.file !== file)
        .concat(outcome.refreshedTargets);
      changes.push(...fileOperations.map((entry) => appliedChange(entry)));
      fileDiffs.push(
        [`--- ${file}`, `+++ ${file}`, formatDiff(sourceFile.source, outcome.rendered, { colorize: false })].join("\n"),
      );
    }

    updatedTargets.sort((a, b) => a.id.localeCompare(b.id));
    return {
      files,
      changes,
      diff: fileDiffs.join("\n\n"),
      diagnostics: [],
      targetSet: { ...this.targetSet, files: updatedFiles, targets: updatedTargets },
    };
  }

  private renderFile(
    file: string,
    sourceFile: OptimizeSourceFile,
    fileOperations: ResolvedOperation[],
  ):
    | { rendered: string; refreshedTargets: OptimizeTarget[] }
    | { diagnostic: OptimizeMutationDiagnostic } {
    // The formatter parse path (no template, no pattern lowering, blank
    // lines preserved) so the rendered file stays faithful to the source.
    const program = parseFormatterStyle(sourceFile.source);
    if (!program) {
      return errorDiagnostic(file, `Failed to parse ${file} from the discovered source.`);
    }

    const entriesById: Record<string, ResolvedOperation> = {};
    for (const entry of fileOperations) entriesById[entry.target.id] = entry;

    let replacedCount = 0;
    for (const { target, assignment } of collectTargets(program, file, sourceFile.absoluteFile)) {
      const entry = entriesById[target.id];
      if (!entry) continue;
      assignment.value = entry.replacement;
      replacedCount += 1;
    }
    if (replacedCount !== fileOperations.length) {
      return errorDiagnostic(file, `Discovered targets no longer match the parsed source of ${file}.`);
    }

    const rendered = generateAgency(program);

    // Round-trip guard: the rendered candidate must parse, and re-collecting
    // targets from it refreshes the catalog exactly as disk discovery would.
    const reparsed = parseAgency(rendered, {}, false);
    if (!reparsed.success) {
      return errorDiagnostic(file, `Rendered candidate for ${file} does not parse: ${reparsed.message ?? "parse error"}`);
    }
    const refreshedTargets = collectTargets(reparsed.result, file, sourceFile.absoluteFile)
      .map((entry) => entry.target);

    return { rendered, refreshedTargets };
  }

  private abortedPreview(diagnostics: OptimizeMutationDiagnostic[]): OptimizeMutationPreview {
    return { files: {}, changes: [], diff: "", diagnostics, targetSet: this.targetSet };
  }

  private validateOperations(operations: OptimizeMutationOperation[]): {
    diagnostics: OptimizeMutationDiagnostic[];
    resolved: ResolvedOperation[];
  } {
    const diagnostics: OptimizeMutationDiagnostic[] = [];
    const resolved: ResolvedOperation[] = [];
    const seenTargets: Record<string, true> = {};

    for (const operation of operations) {
      if (seenTargets[operation.target]) {
        diagnostics.push({
          target: operation.target,
          code: "duplicate-target-operation",
          message: `Multiple operations for target ${operation.target} in one batch. Combine them into a single operation.`,
        });
        continue;
      }
      seenTargets[operation.target] = true;
      const outcome = this.validateOperation(operation);
      if ("diagnostic" in outcome) {
        diagnostics.push(outcome.diagnostic);
      } else {
        resolved.push(outcome.resolved);
      }
    }

    return { diagnostics, resolved };
  }

  private validateOperation(operation: OptimizeMutationOperation): ValidationOutcome {
    const target = this.targetsById[operation.target];
    // Operations usually arrive as parsed LLM output, so validate the
    // discriminants as plain strings instead of trusting the static union.
    const targetKind: string | undefined = target?.kind;
    const operationKind: string = operation.kind;
    const operationOp: string = operation.op;

    if (operationKind === "type" && (!target || targetKind === "type")) {
      return diagnostic({ operation, code: "unsupported-operation", message: "`optimize type` targets are not supported in v1. Only variable initializer replacement is available." });
    }
    if (!target) {
      return diagnostic({ operation, code: "unknown-target", message: `Unknown optimize target ${operation.target}. Known targets: ${this.targetSet.targets.map((known) => known.id).join(", ")}` });
    }
    if (targetKind !== operationKind) {
      return diagnostic({ operation, code: "kind-mismatch", message: `Operation kind ${operationKind} does not match target ${operation.target} of kind ${targetKind}.` });
    }
    if (operationOp !== "replaceInitializer") {
      return diagnostic({ operation, code: "unsupported-operation", message: `Operation ${operationOp} is not supported for ${operationKind} targets. Use replaceInitializer.` });
    }
    if (operation.expected !== undefined && operation.expected !== target.value) {
      return diagnostic({ operation, code: "expected-mismatch", message: `Expected value does not match the current value of ${operation.target}: ${JSON.stringify(target.value)}.` });
    }
    return this.resolveReplacementValue(operation as ReplaceVariableInitializerOperation, target);
  }

  private resolveReplacementValue(
    operation: ReplaceVariableInitializerOperation,
    target: OptimizeTarget,
  ): ValidationOutcome {
    let parsed = exprParser(operation.value);
    if (!parsed.success || parsed.rest.trim() !== "") {
      // The model frequently returns the raw prompt text without the surrounding
      // quotes. Recover by wrapping it in the target's quote style and re-parsing.
      // This is self-validating — values that don't wrap into a clean single
      // expression (e.g. embedded quotes, or newlines under single-quote style)
      // fall through to the diagnostic, so we never emit broken source.
      const quote = target.valueKind === "multilineString" ? `"""` : `"`;
      const wrapped = exprParser(`${quote}${operation.value}${quote}`);
      if (!wrapped.success || wrapped.rest.trim() !== "") {
        return diagnostic({ operation, code: "invalid-replacement-syntax", message: `Replacement value for ${operation.target} must be a quoted Agency string literal (e.g. "new prompt"), but it did not parse as one even after wrapping it in quotes. Received: ${JSON.stringify(operation.value)}` });
      }
      parsed = wrapped;
    }
    const replacement = parsed.result;
    if (replacement.type !== "string" && replacement.type !== "multiLineString") {
      return diagnostic({ operation, code: "unsupported-value-domain", message: `Replacement value for ${operation.target} must be a string or multiline string expression in v1; got ${replacement.type}.` });
    }
    const newValue = promptSegmentsToString(replacement.segments);
    const validation = validateOptimizedStringValue(target.value, newValue);
    if (!validation.ok) {
      return diagnostic({ operation, code: "interpolation-mismatch", message: `Replacement value for ${operation.target} is invalid: ${validation.reason}` });
    }
    return { resolved: { operation, target, replacement, newValue } };
  }
}

function diagnostic(args: {
  operation: OptimizeMutationOperation;
  code: OptimizeMutationDiagnostic["code"];
  message: string;
}): { diagnostic: OptimizeMutationDiagnostic } {
  return { diagnostic: { target: args.operation.target, code: args.code, message: args.message } };
}

function errorDiagnostic(
  file: string,
  message: string,
): { diagnostic: OptimizeMutationDiagnostic } {
  return { diagnostic: { code: "parse-failed", message: `${message} (file: ${file})` } };
}

function appliedChange(entry: ResolvedOperation): OptimizeAppliedChange {
  return {
    target: entry.target.id,
    kind: entry.operation.kind,
    op: entry.operation.op,
    oldValue: entry.target.value,
    newValue: entry.newValue,
    ...(entry.operation.rationale !== undefined ? { rationale: entry.operation.rationale } : {}),
  };
}

function parseFormatterStyle(source: string): AgencyProgram | null {
  const parsed = parseAgency(replaceBlankLines(source), {}, false, false);
  return parsed.success ? parsed.result : null;
}

function operationForTarget(target: OptimizeTarget, value: string): OptimizeMutationOperation {
  if (target.kind === "variable") {
    return { target: target.id, kind: "variable", op: "replaceInitializer", value };
  }
  return { target: target.id, kind: "type", op: "replaceTypeDefinition", value };
}

/** Preview a set of operations against a target set. Shared by greedy and GEPA. */
export function defaultPreview(targetSet: OptimizeTargetSet, operations: OptimizeMutationOperation[]): OptimizeMutationPreview {
  return new OptimizeSourceMutator({ targetSet }).preview(operations);
}

function writeFileEnsuringDir(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
