/**
 * The whole workflow generator with the I/O taken out, and the helpers
 * `stdlib/workflow.agency` imports. The Agency side does the one thing that
 * needs an approval, reading a tool's module, and calls these for the rest.
 */
import { currentHost } from "../../runtime/currentHost.js";
import { failure, success, type ResultFailure, type ResultSuccess } from "../../runtime/result.js";
import { lowerWorkflow } from "./lower.js";
import { parseWorkflow } from "./parse.js";
import { problemsFromDiagnostics, type Diagnostic } from "./problems.js";
import { renderWorkflow } from "./render.js";
import { resolveWorkflow, signatureKey } from "./resolve.js";
import { toolRefs } from "./tools.js";
import type { Owner, Problem, Range, Signature, ToolRef } from "./types.js";

export type Compiled = {
  source: string;
  ranges: Range[];
  typeOwners: Record<string, Owner>;
  warnings: Problem[];
};
export type CompileResult =
  { compiled: Compiled; problems: [] } | { compiled: null; problems: Problem[] };

/** Parse, resolve, lower, and render, stopping at the first stage with problems. */
export function compileWorkflowSource(
  value: unknown,
  refs: ToolRef[],
  signatures: Record<string, Signature>,
): CompileResult {
  const parsed = parseWorkflow(value);
  if (parsed.workflow === null) {
    return { compiled: null, problems: parsed.problems };
  }
  const resolved = resolveWorkflow(parsed.workflow, refs, signatures);
  if (resolved.resolved === null) {
    return { compiled: null, problems: resolved.problems };
  }
  const rendered = renderWorkflow(lowerWorkflow(resolved.resolved));
  if (rendered.source === null) {
    return { compiled: null, problems: rendered.problems };
  }
  const compiled = {
    source: rendered.source,
    ranges: rendered.ranges,
    typeOwners: rendered.typeOwners,
    warnings: resolved.resolved.warnings,
  };
  return { compiled, problems: [] };
}

function describeProblem({ step, field, message }: Problem): string {
  const where = [step === null ? "" : `step ${step}`, field ?? ""].filter((part) => part !== "");
  return where.length === 0 ? message : `${where.join(", ")}: ${message}`;
}

/** A failure whose message lists the problems and whose data carries them. */
export function _problemsFailure(problems: Problem[]): ResultFailure {
  const message = `the workflow has problems:\n${problems.map(describeProblem).join("\n")}`;
  return failure(message, { problems });
}

/** The tools as import references. Throws on a tool that cannot be
 *  imported; the Agency caller turns that into a failure with `try`. */
export function _toolRefs(tools: unknown[], dir: string): ToolRef[] {
  return toolRefs(tools, dir, currentHost().system.cwd());
}

/** One module's tools. `reExport` is the line `describe` reads for a shared
 *  module; a local file has none and is read from disk. */
export type SignatureSource = { module: string; names: string[]; reExport: string | null };

export function _signatureSources(refs: ToolRef[]): SignatureSource[] {
  const modules = refs
    .map((ref) => ref.module)
    .filter((module, index, all) => all.indexOf(module) === index);
  return modules.sort().map((module) => {
    const names = refs
      .filter((ref) => ref.module === module)
      .map((ref) => ref.name)
      .sort();
    const isLocal = module.startsWith("./");
    const reExport = isLocal ? null : `export { ${names.join(", ")} } from "${module}"`;
    return { module, names, reExport };
  });
}

type DescribedExport = { name: string; kind: string } & Signature;

const FUNCTION_KINDS = ["def", "reexport"];

/** Each of `source`'s names, keyed by module and name, from what `describe`
 *  said about the module. */
export function _pickSignatures(
  source: SignatureSource,
  exports: DescribedExport[],
): ResultSuccess | ResultFailure {
  const signatures: Record<string, Signature> = {};
  for (const name of source.names) {
    const found = exports.find(
      (entry) => entry.name === name && FUNCTION_KINDS.includes(entry.kind),
    );
    if (found === undefined) {
      return failure(`"${source.module}" exports no function named "${name}"`);
    }
    const { signature, returnType, docstring } = found;
    signatures[signatureKey(source.module, name)] = { signature, returnType, docstring };
  }
  return success(signatures);
}

export function _compileWorkflowSource(
  value: unknown,
  refs: ToolRef[],
  signatures: Record<string, Signature>,
): ResultSuccess | ResultFailure {
  const result = compileWorkflowSource(value, refs, signatures);
  return result.compiled === null ? _problemsFailure(result.problems) : success(result.compiled);
}

/** A failure for one problem that belongs to the whole workflow. */
export function _workflowFailure(message: string): ResultFailure {
  return _problemsFailure([{ step: null, field: null, message }]);
}

export function _problemsFromDiagnostics(
  diagnostics: Diagnostic[],
  ranges: Range[],
  typeOwners: Record<string, Owner>,
): Problem[] {
  return problemsFromDiagnostics(diagnostics, ranges, typeOwners);
}
