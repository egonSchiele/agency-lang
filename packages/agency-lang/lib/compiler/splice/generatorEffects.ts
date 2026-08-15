/**
 * Deciding whether a generator's effects allow it to run at compile time.
 *
 * Split from eligibility.ts, which owns the other two rules (no nested splice,
 * imports stay inside Agency). This file answers one question: can this
 * generator reach something risky, and could we read enough to be sure?
 */
import path from "node:path";
import { SymbolTable } from "../../symbolTable.js";
import { argumentExpression, collectBodyFacts } from "../../analysis/bodyFacts.js";
import { callableNamesIn, reachableFrom } from "../../analysis/effects.js";
import { declaredName } from "../../types/hole.js";
import { walkNodesArray } from "../../utils/node.js";
import { closureFiles, importEdgesOf, isAgencyFilePath, parseFileOrNull } from "./eligibility.js";
import type { AgencyConfig } from "../../config.js";
import type { AgencyProgram } from "../../types.js";
import type { Hole } from "../../types/hole.js";
import type { FunctionDefinition } from "../../types/function.js";
import type { GraphNodeDefinition } from "../../types/graphNode.js";
import type { SpliceDiagnostic } from "./types.js";

/**
 * Refuse a generator that can reach a risky operation, and refuse one whose
 * effects cannot be read at all.
 *
 * The second half carries the weight. The effect walk reads syntax, so it
 * cannot see through a compile-time splice, a function received as a parameter,
 * a function reference held in a variable, or a file that did not parse. An
 * empty list from a reading that saw none of those is not evidence of safety.
 *
 * Scoped to what the generator reaches BY CALLING. Every file reaches the
 * prelude and passing a function as a value is ordinary Agency, so a
 * file-scoped rule would refuse every generator, which is the same objection
 * the comment on checkGeneratorEligible raises against a whole-closure test.
 */
export function checkGeneratorEffects(
  generatorPath: string,
  generatorName: string,
  config: AgencyConfig = {},
  symbolTable?: SymbolTable,
): SpliceDiagnostic | null {
  const absolute = path.resolve(generatorPath);
  const table = symbolTable ?? SymbolTable.build(absolute, config);
  const symbol = table.getFile(absolute)?.[generatorName];
  if (!symbol || (symbol.kind !== "function" && symbol.kind !== "node")) {
    return refusal(generatorName, "its definition could not be found");
  }

  // Every effect, sorted, not just the first: refusing one at a time means the
  // user fixes it and is immediately refused for the next. Matches how AG3013
  // reports what a raises clause exceeded.
  const effects = (symbol.interruptEffects ?? []).map((entry) => entry.effect).sort();
  if (effects.length > 0) {
    return {
      diagnostic: "spliceGeneratorRaises",
      params: { name: generatorName, effects: effects.join(", ") },
      loc: { line: 0, col: 0, start: 0, end: 0 },
    };
  }

  const blindSpot = firstBlindSpot(table, absolute, generatorName, config);
  return blindSpot === null ? null : refusal(generatorName, blindSpot);
}

function refusal(name: string, reason: string): SpliceDiagnostic {
  return {
    diagnostic: "spliceGeneratorUnreadable",
    params: { name, reason },
    loc: { line: 0, col: 0, start: 0, end: 0 },
  };
}

/** The first relative `.agency` file the generator can reach that does not
 *  parse. closureFiles cannot answer this: it drops a file it cannot parse
 *  rather than reporting it, which is right for its own callers and wrong
 *  here, where an unreadable file is the whole point. */
function firstUnparseableImport(generatorFile: string, config: AgencyConfig): string | null {
  const reachable = [path.resolve(generatorFile), ...closureFiles(generatorFile, config)];
  for (const file of reachable) {
    const program = parseFileOrNull(file, config);
    if (program === null) return file;
    const broken = importEdgesOf(program)
      .filter(isAgencyFilePath)
      .map((specifier) => path.resolve(path.dirname(file), specifier))
      .find((target) => parseFileOrNull(target, config) === null);
    if (broken !== undefined) return broken;
  }
  return null;
}

/** The first reason the effect reading is incomplete, or null when the whole
 *  call graph could be read. Each reason names the file or function so the
 *  user can go and look. */
function firstBlindSpot(
  table: SymbolTable,
  generatorFile: string,
  generatorName: string,
  config: AgencyConfig,
): string | null {
  const programs = programsFor(table, config);
  const unreadable = firstUnparseableImport(generatorFile, config);
  if (unreadable !== null) {
    return `it reaches ${path.basename(unreadable)}, which does not parse`;
  }
  for (const reached of reachableFrom(table, programs, {
    file: generatorFile,
    name: generatorName,
  })) {
    const program = programs[reached.file];
    const declaration = program && declarationOf(program, reached.name);
    if (!declaration) continue;
    const reason = blindSpotIn(table, program, reached.file, declaration);
    if (reason !== null) return reason;
  }
  return null;
}

/** What this one declaration hides from a syntax-only reading. */
function blindSpotIn(
  table: SymbolTable,
  program: AgencyProgram,
  file: string,
  declaration: FunctionDefinition | GraphNodeDefinition,
): string | null {
  const fileLabel = path.basename(file);
  const nodes = [...walkNodesArray(declaration.body)].map((visit) => visit.node);
  if (nodes.some((node) => node.type === "splice")) {
    return `it reaches ${fileLabel}, which contains a compile-time splice`;
  }
  const parameterNames = (declaration.parameters ?? []).map((parameter) => parameter.name);
  const facts = collectBodyFacts(declaration.body);
  const throughParameter = facts.callees.find((callee: string) => parameterNames.includes(callee));
  if (throughParameter !== undefined) {
    return `it reaches ${declaredName(nameOf(declaration))}, which calls '${throughParameter}', a function it received as a parameter`;
  }
  const held = heldFunctionReference(table, program, file, declaration);
  if (held !== null) {
    return `it reaches ${declaredName(nameOf(declaration))}, which passes '${held}' through a variable`;
  }
  return null;
}

function nameOf(declaration: FunctionDefinition | GraphNodeDefinition): string | Hole {
  return declaration.type === "function" ? declaration.functionName : declaration.nodeName;
}

/**
 * A function reference aliased into a local and then handed to a call, which
 * the walk cannot follow.
 *
 * Two things narrow this from "any alias" to "an alias of something callable".
 *
 * A symbol-table lookup: `const label = title` where both are strings is
 * ordinary renaming, not a hidden call, and refusing it would reject
 * generators that are entirely fine. The alias only counts when the name it
 * aliases resolves to a function or node, or to a parameter whose declared
 * type is a function.
 *
 * And every argument shape: `f(cb: handler)` and `f(...refs)` are the two
 * forms most likely to carry a callback, so checking only bare positional
 * arguments would miss the cases this exists for. Missing a real blind spot is
 * the dangerous direction here.
 */
function heldFunctionReference(
  table: SymbolTable,
  program: AgencyProgram,
  file: string,
  declaration: FunctionDefinition | GraphNodeDefinition,
): string | null {
  const callable = callableNames(table, program, file, declaration);
  const aliases: Record<string, string> = Object.create(null);
  for (const { node } of walkNodesArray(declaration.body)) {
    if (node.type !== "assignment") continue;
    const value = node.value;
    if (value?.type === "variableName" && callable.includes(value.value)) {
      aliases[node.variableName] = value.value;
    }
  }
  for (const { node } of walkNodesArray(declaration.body)) {
    if (node.type !== "functionCall") continue;
    for (const argument of node.arguments) {
      const expression = argumentExpression(argument);
      if (expression.type === "variableName" && Object.hasOwn(aliases, expression.value)) {
        return aliases[expression.value];
      }
    }
  }
  return null;
}

/** Names in scope here that denote something callable: a function or node the
 *  file can see, or a parameter declared with a function type. */
function callableNames(
  table: SymbolTable,
  program: AgencyProgram,
  file: string,
  declaration: FunctionDefinition | GraphNodeDefinition,
): string[] {
  const symbols = callableNamesIn(table, program, file);
  const functionParameters = (declaration.parameters ?? [])
    .filter((parameter) => parameter.typeHint?.type === "blockType")
    .map((parameter) => parameter.name);
  return [...symbols, ...functionParameters];
}

function declarationOf(
  program: AgencyProgram,
  name: string,
): FunctionDefinition | GraphNodeDefinition | null {
  for (const { node } of walkNodesArray(program.nodes)) {
    if (node.type !== "function" && node.type !== "graphNode") continue;
    if (declaredName(nameOf(node)) === name) return node;
  }
  return null;
}

/**
 * The parse tree of every file the table crawled, keyed by path.
 *
 * Memoized against the table, because this runs once per splice site and the
 * answer cannot differ between sites: the crawl is already finished by the
 * time any of them are checked. Without it, a file with ten splices re-parses
 * the prelude and everything it drags in ten times — and a cache hit in
 * parseAgencyFileCached still deep-copies the whole tree
 * (lib/parseCache.ts:96), so the copying alone is the cost.
 *
 * Keyed by table identity with a WeakMap, so the entry dies with the table
 * rather than living as run state.
 */
const programsByTable = new WeakMap<SymbolTable, Record<string, AgencyProgram>>();

function programsFor(table: SymbolTable, config: AgencyConfig): Record<string, AgencyProgram> {
  const cached = programsByTable.get(table);
  if (cached) return cached;
  const programs: Record<string, AgencyProgram> = Object.create(null);
  for (const file of table.filePaths()) {
    const program = parseFileOrNull(file, config);
    if (program !== null) programs[file] = program;
  }
  programsByTable.set(table, programs);
  return programs;
}
