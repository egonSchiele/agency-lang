import path from "node:path";
import { walkNodesArray } from "../utils/node.js";
import { generateExpression } from "../backends/agencyGenerator.js";
import { declaredName } from "../types/hole.js";
import { getImportedNames } from "../types/importStatement.js";
import { bindersOf, freeNamesOf } from "../runtime/template/hygiene.js";
import { BUILTIN_VARIABLES } from "../config.js";
import { PRELUDE_NAMES } from "../prelude.js";
import { BUILTIN_FUNCTION_TYPES } from "../typeChecker/builtins.js";
import { KINDS_FOR_SORT, stampOrigin } from "../runtime/template/origin.js";
import { kindOf } from "../runtime/template/code.js";
import {
  checkGeneratorEligible,
  resolveGeneratorModule,
  resolveImportedName,
} from "../compiler/splice/eligibility.js";
import type { ImportSource } from "../compiler/splice/eligibility.js";
import { runGenerator } from "../compiler/splice/runGenerator.js";
import {
  cachedEligibility,
  cachedGeneratorRun,
  spliceCacheKey,
  spliceCacheSlot,
} from "../compiler/splice/cache.js";
import type { SymbolTable } from "@/symbolTable.js";
import type { AgencyConfig } from "../config.js";
import type { AgencyNode, AgencyProgram } from "../types.js";
import type { Splice } from "../types/splice.js";
import type { Code } from "../runtime/template/code.js";
import type {
  SpliceDiagnostic,
  SpliceResult,
} from "../compiler/splice/types.js";

/**
 * Expand every `$( ... )` in a program: run its generator and paste the
 * `Code` value back in its place.
 *
 * AST in, AST out. Pasting nodes keeps source positions intact and keeps
 * `loc.origin` stamps alive, which printing and re-parsing would lose.
 *
 * Three phases, kept separate because they change for different reasons:
 * decide whether the generator may run, run it, then check the fragment
 * fits this position and paste it. The kind check belongs in the third
 * phase because it needs the result.
 */

/** Files currently being expanded, for the re-entry guard below. */
const inProgress: Record<string, true> = Object.create(null);

/** Per-call overrides. Only the editor sets these, to keep a runaway
 *  generator from freezing a single-threaded language server. */
export type ExpandOptions = {
  wallClockMs?: number;
  /** The caller's symbol table, so the effect check does not crawl and parse
   *  every reachable file again at each splice site. Callers that have one
   *  should pass it; the check builds its own when they do not. */
  symbolTable?: SymbolTable;
};

export function expandSplices(
  program: AgencyProgram,
  hostPath: string,
  config: AgencyConfig = {},
  options: ExpandOptions = {},
): SpliceResult<AgencyProgram> {
  const splices = splicesIn(program);
  if (splices.length === 0) {
    // Identity, not a copy. Most files have no splices and pay nothing.
    return { ok: true, value: program };
  }

  // Running a generator compiles it, which builds a symbol table, which
  // walks files and can arrive back here. A file that reached itself would
  // recurse until the stack ran out.
  const key = path.resolve(hostPath);
  if (Object.hasOwn(inProgress, key)) {
    return {
      ok: false,
      diagnostic: {
        diagnostic: "spliceNested",
        params: { name: path.basename(key), path: key },
        loc: splices[0].loc ?? ORIGIN_UNKNOWN,
      },
    };
  }
  inProgress[key] = true;
  try {
    return expandAll(program, splices, hostPath, config, options);
  } finally {
    delete inProgress[key];
  }
}

const ORIGIN_UNKNOWN = { line: 0, col: 0, start: 0, end: 0 };

/**
 * Every splice the host file owns.
 *
 * `walkNodesArray` does not descend into a code literal, which is what
 * leaves a splice inside `[| ... |]` alone. That body belongs to the
 * program being generated, so its splices are that program's business.
 */
function splicesIn(program: AgencyProgram): Splice[] {
  return [...walkNodesArray(program.nodes)]
    .map((visit) => visit.node)
    .filter((node): node is Splice => node.type === "splice");
}

function expandAll(
  program: AgencyProgram,
  splices: Splice[],
  hostPath: string,
  config: AgencyConfig,
  options: ExpandOptions,
): SpliceResult<AgencyProgram> {
  // Imported names count as taken. A generated `def greet` collides with an
  // imported `greet` exactly as it would with a declared one.
  const taken = [...declaredNamesIn(program), ...importedNamesIn(program.nodes)];
  // Keyed by object identity, not position. A declaration splice spreads N
  // nodes and shifts the index of every splice after it.
  const expansions = new Map<Splice, AgencyNode[]>();

  for (const splice of splices) {
    const expanded = expandOne(splice, program, hostPath, config, options);
    if (!expanded.ok) {
      return expanded;
    }
    const collision = checkNoRedeclaration(splice, expanded.value, taken);
    if (collision !== null) {
      return { ok: false, diagnostic: collision };
    }
    taken.push(...declaredNamesIn({ type: "agencyProgram", nodes: expanded.value }));
    expansions.set(splice, expanded.value);
  }
  return { ok: true, value: rewrite(program, expansions) as AgencyProgram };
}

function expandOne(
  splice: Splice,
  program: AgencyProgram,
  hostPath: string,
  config: AgencyConfig,
  options: ExpandOptions,
): SpliceResult<AgencyNode[]> {
  const decided = decide(splice, program, hostPath, config, options);
  if (!decided.ok) {
    return decided;
  }
  const { generator, argumentSources } = decided.value;

  const expression = generateExpression(splice.expression);
  const slot = spliceCacheSlot(expression, generator.modulePath);
  // Every module the runner will import, not just the generator. A module
  // supplying an argument is imported by the HOST, so it can be absent
  // from the generator's own closure while still deciding what the
  // generator returns.
  const fingerprint = spliceCacheKey(
    expression,
    [
      generator.modulePath,
      ...argumentSources
        .map((entry) => entry.source?.modulePath)
        .filter((modulePath): modulePath is string => typeof modulePath === "string"),
    ],
    config,
  );

  // Eligibility is memoized on the same fingerprint as the result. It runs
  // before the generator, so it sits outside cachedGeneratorRun and would
  // otherwise re-walk the closure on every call.
  const ineligible = cachedEligibility(slot, fingerprint, () =>
    CHECKS.reduce<SpliceDiagnostic | null>(
      (found, check) => found ?? check(decided.value),
      null,
    ),
  );
  if (ineligible !== null) {
    return {
      ok: false,
      diagnostic: { ...ineligible, loc: splice.loc ?? ORIGIN_UNKNOWN },
    };
  }

  const produced = cachedGeneratorRun(
    slot,
    fingerprint,
    () =>
      runGenerator(splice, generator, path.dirname(path.resolve(hostPath)), {
        config,
        wallClockMs: options.wallClockMs,
        argumentSources: argumentSources
          .map((entry) => entry.source)
          .filter((source): source is ImportSource => source !== null),
      }),
  );
  if (!produced.ok) {
    // A cached failure carries the position of whichever splice ran first,
    // so re-anchor it or the editor underlines the wrong line.
    return {
      ok: false,
      diagnostic: { ...produced.diagnostic, loc: splice.loc ?? ORIGIN_UNKNOWN },
    };
  }
  return graft(splice, produced.value, generator.exportedName);
}

// ---------------------------------------------------------------------------
// Phase 1: decide (resolve the generator, then apply CHECKS)
// ---------------------------------------------------------------------------

type DecisionContext = {
  splice: Splice;
  localName: string;
  generator: { modulePath: string; exportedName: string };
  config: AgencyConfig;
  /** Every free name the arguments use, and where each comes from. */
  argumentSources: Array<{ name: string; source: ImportSource | null }>;
  symbolTable?: SymbolTable;
};

/** The eligibility rules, in order, applied by a short-circuiting reduce
 *  so a later rule never pays for an earlier refusal. Adding one means
 *  adding an entry here rather than editing the pass. */
const CHECKS: ReadonlyArray<(ctx: DecisionContext) => SpliceDiagnostic | null> = [
  checkArgumentsAvailable,
  ({ generator, config, symbolTable }) =>
    checkGeneratorEligible(
      generator.modulePath,
      generator.exportedName,
      config,
      symbolTable,
    ),
];

function decide(
  splice: Splice,
  program: AgencyProgram,
  hostPath: string,
  config: AgencyConfig,
  options: ExpandOptions,
): SpliceResult<DecisionContext> {
  const localName = calleeName(splice);
  if (localName === null) {
    return {
      ok: false,
      diagnostic: {
        diagnostic: "spliceGeneratorNotImported",
        params: { name: generateExpression(splice.expression) },
        loc: splice.loc ?? ORIGIN_UNKNOWN,
      },
    };
  }
  // Resolving produces the module and name, so it is not one of the checks
  // above even though it can fail. They are checked against its result.
  const resolved = resolveGeneratorModule(program, localName, hostPath);
  if (!resolved.ok) {
    return {
      ok: false,
      diagnostic: { ...resolved.diagnostic, loc: splice.loc ?? ORIGIN_UNKNOWN },
    };
  }

  return {
    ok: true,
    value: {
      splice,
      localName,
      generator: resolved.value,
      config,
      symbolTable: options.symbolTable,
      argumentSources: argumentSourcesFor(splice, program, hostPath).filter(
        (entry) => entry.name !== localName,
      ),
    },
  };
}

/** A splice calls its generator; anything else has no generator to name. */
function calleeName(splice: Splice): string | null {
  const expression = splice.expression as { type: string; functionName?: string };
  return expression.type === "functionCall" && expression.functionName !== undefined
    ? expression.functionName
    : null;
}

/**
 * A splice's arguments run before this file exists, so they may name only
 * things that already exist: literals, code literals, and imported names.
 *
 * This is a safelist. Refusing only names that collide with the file's
 * top-level declarations would miss an enclosing local, because a splice
 * in expression position sits inside a function body:
 *
 *     node main(): number {
 *       const size = 3
 *       return $( buildTable(size) )
 *     }
 *
 * `size` is not a top-level name, so a blocklist lets it through, and the
 * user gets a ReferenceError from a program they never wrote instead of
 * the AG8011 that exists to explain this.
 *
 * Builtins are allowed alongside imports. They are supplied by the
 * language rather than by the file, so they exist before it does.
 */
function checkArgumentsAvailable({
  splice,
  argumentSources,
}: DecisionContext): SpliceDiagnostic | null {
  const unresolved = argumentSources.find(
    (entry) => entry.source === null && !BUILTIN_VARIABLES.includes(entry.name),
  );
  if (unresolved !== undefined) {
    return {
      diagnostic: "spliceArgumentNotAvailable",
      params: { name: unresolved.name },
      loc: splice.loc ?? ORIGIN_UNKNOWN,
    };
  }
  return null;
}

/** Every free name a splice's arguments use, with where it comes from. */
function argumentSourcesFor(
  splice: Splice,
  program: AgencyProgram,
  hostPath: string,
): Array<{ name: string; source: ImportSource | null }> {
  const free = freeNamesOf({
    type: "agencyProgram",
    kind: "expr",
    nodes: [splice.expression as AgencyNode],
  });
  return free.map((name) => ({
    name,
    source: resolveImportedName(program, name, hostPath),
  }));
}

/**
 * A splice may not generate a declaration whose name is already taken.
 *
 * Agency does not catch this on its own. Two `def`s with one name is a
 * hard error, but two top-level `const`s is not, and the later one
 * silently wins. Without this rule a generator could quietly replace one
 * of the author's constants.
 */
function checkNoRedeclaration(
  splice: Splice,
  nodes: AgencyNode[],
  taken: string[],
): SpliceDiagnostic | null {
  const clash = declaredNamesIn({ type: "agencyProgram", nodes }).find((name) =>
    taken.includes(name),
  );
  return clash === undefined
    ? null
    : {
        diagnostic: "spliceRedeclaresHostName",
        params: { name: calleeName(splice) ?? "the generator", declared: clash },
        loc: splice.loc ?? ORIGIN_UNKNOWN,
      };
}

/** Top-level names the host file declares. */
function declaredNamesIn(program: AgencyProgram): string[] {
  return program.nodes.flatMap((node) => {
    if (node.type === "function") return [declaredName(node.functionName)];
    if (node.type === "graphNode") return [declaredName(node.nodeName)];
    if (node.type === "assignment") return [node.variableName];
    if (node.type === "typeAlias") return [node.aliasName];
    return [];
  });
}

// ---------------------------------------------------------------------------
// Phase 3: graft
// ---------------------------------------------------------------------------

/** Check the fragment fits this position, then stamp and hand back the
 *  nodes to paste. */
/**
 * Generated code may reference only names it declares itself and names it
 * imports. Anything else is AG8010.
 *
 * A generated expression lands next to the locals at the splice site, so a
 * generated mention of `tmp` would silently read the local `tmp`.
 *
 * Renaming, the way `hygiene.ts` does for fills, would be wrong here: a
 * declaration splice exists so that `greet` keeps its name. This checks
 * instead, and it reads the fragment's own import lines rather than the
 * host's, so generated code never depends on where it lands.
 */
function checkNoCapture(
  splice: Splice,
  code: Code,
  generatorName: string,
): SpliceDiagnostic | null {
  const allowed = [
    ...bindersOf(code),
    ...declaredNamesIn({ type: "agencyProgram", nodes: code.nodes }),
    ...importedNamesIn(code.nodes),
    ...BUILTIN_VARIABLES,
    ...PRELUDE_NAMES,
    ...Object.keys(BUILTIN_FUNCTION_TYPES),
  ];
  const reached = [...freeNamesOf(code), ...calledNamesIn(code.nodes)].find(
    (name) => !allowed.includes(name),
  );
  return reached === undefined
    ? null
    : {
        diagnostic: "spliceReferencesOuterName",
        params: { name: reached, generator: generatorName },
        loc: splice.loc ?? ORIGIN_UNKNOWN,
      };
}

/**
 * Names a fragment calls.
 *
 * `freeNamesOf` sees `variableName` nodes only, and a call holds its
 * callee as a plain string, so calls are invisible to it. Without this the
 * rule would refuse to read a host variable while happily calling a host
 * function.
 */
function calledNamesIn(nodes: AgencyNode[]): string[] {
  return [...walkNodesArray(nodes)]
    .map((visit) => visit.node)
    .filter((node) => node.type === "functionCall")
    .map((node) => (node as { functionName: string }).functionName);
}

/**
 * Every local name a fragment's import lines bind.
 *
 * Through `getImportedNames`, which already handles all three import
 * forms. Handling only `namedImport` would make AG8010 reject generated
 * code that imports a namespace or a default and then uses it, which is
 * legal and has nothing to do with capture. `import node { ... }` binds
 * its names directly.
 */
function importedNamesIn(nodes: AgencyNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === "importNodeStatement") {
      return node.importedNodes;
    }
    if (node.type !== "importStatement") {
      return [];
    }
    return node.importedNames.flatMap(getImportedNames);
  });
}

/**
 * Which fragment kinds fit each splice position.
 *
 * The shared hole table from `graft.ts`, plus `statements` in declaration
 * position. Kind inference is smallest-first, so a literal holding only
 * `const config = "x"` stops at `statements` and never reaches `program`.
 * Requiring `program` would make generated constants impossible. At the
 * top level a statement is a declaration, so this costs nothing.
 */
/** Exhaustive, not a ternary: a third position value silently described a
 *  statement mismatch as "expression position needs an expr fragment". */
function expectedKindFor(position: Splice["position"]): string {
  switch (position) {
    case "decl":
      return "program";
    case "statement":
      return "statements";
    case "expr":
      return "expr";
  }
}

function positionLabel(position: Splice["position"]): string {
  switch (position) {
    case "decl":
      return "declaration";
    case "statement":
      return "statement";
    case "expr":
      return "expression";
  }
}

const KINDS_FOR_POSITION: Record<Splice["position"], string[]> = {
  decl: [...KINDS_FOR_SORT.decl, "statements"],
  // The same set a statements HOLE accepts, right for the same reason: an
  // expression is a legal statement, and a program grafted into a body is
  // judged when the completed program compiles.
  statement: KINDS_FOR_SORT.statements,
  expr: KINDS_FOR_SORT.expr,
};

/**
 * Generated declarations may not be exported.
 *
 * Other files learn what a module exports by reading its source, not by
 * compiling it, so an exported generated name would only resolve for
 * callers willing to run the generator. Refused here rather than left to
 * surface as "not defined" in the importing file. Tracked as #687.
 */
function checkNoGeneratedExport(
  splice: Splice,
  code: Code,
  generatorName: string,
): SpliceDiagnostic | null {
  const exported = code.nodes.find(isExporting);
  if (exported === undefined) {
    return null;
  }
  return {
    diagnostic: "spliceGeneratedExport",
    params: { name: generatorName, declared: exportedNameOf(exported) },
    loc: splice.loc ?? ORIGIN_UNKNOWN,
  };
}

/**
 * Agency exports two ways, and only one sets a flag.
 *
 * `export def greet()` marks the declaration with `exported: true`.
 * `export { greet } from "./other.agency"` is its own node type carrying
 * no such flag, and a code literal can hold one, so checking the flag
 * alone let a generated re-export through.
 */
function isExporting(node: AgencyNode): boolean {
  return (
    (node as { exported?: boolean }).exported === true ||
    node.type === "exportFromStatement"
  );
}

function exportedNameOf(node: AgencyNode): string {
  if (node.type === "exportFromStatement") {
    const body = (node as { body?: { names?: string[] } }).body;
    return body?.names?.[0] ?? "a re-export";
  }
  return declaredNamesIn({ type: "agencyProgram", nodes: [node] })[0] ?? "a declaration";
}

function graft(
  splice: Splice,
  code: Code,
  generatorName: string,
): SpliceResult<AgencyNode[]> {
  // Splices are expressions, so a generator can return a fragment holding
  // one. This pass enumerates the host's splices once, so a generated
  // splice would survive to the codegen tripwire and surface as an
  // internal error. Refuse it here, where the message can name the
  // generator.
  const nested = [...walkNodesArray(code.nodes)].some(
    (visit) => visit.node.type === "splice",
  );
  if (nested) {
    return {
      ok: false,
      diagnostic: {
        diagnostic: "spliceNested",
        params: { name: generatorName, path: "the code it returned" },
        loc: splice.loc ?? ORIGIN_UNKNOWN,
      },
    };
  }
  const exported = checkNoGeneratedExport(splice, code, generatorName);
  if (exported !== null) {
    return { ok: false, diagnostic: exported };
  }
  const captured = checkNoCapture(splice, code, generatorName);
  if (captured !== null) {
    return { ok: false, diagnostic: captured };
  }
  if (!KINDS_FOR_POSITION[splice.position].includes(kindOf(code))) {
    return {
      ok: false,
      diagnostic: {
        diagnostic: "spliceFragmentKindMismatch",
        params: {
          name: generatorName,
          actual: kindOf(code),
          expected: expectedKindFor(splice.position),
          position: positionLabel(splice.position),
        },
        loc: splice.loc ?? ORIGIN_UNKNOWN,
      },
    };
  }
  return {
    ok: true,
    value: stampOrigin(code.nodes, { kind: "splice", name: generatorName }),
  };
}

/**
 * Replace each splice with the nodes it expanded to.
 *
 * In an array a splice spreads, since a declaration splice can produce
 * several declarations. Everywhere else the kind check has already
 * guaranteed exactly one node. Code literals pass through untouched.
 */
function rewrite(node: unknown, expansions: Map<Splice, AgencyNode[]>): unknown {
  if (Array.isArray(node)) {
    return node.flatMap((item) => {
      const replacement = expansions.get(item as Splice);
      return replacement ?? [rewrite(item, expansions)];
    });
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const source = node as Record<string, unknown>;
  if (source.type === "codeLiteral") {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    const replacement = expansions.get(value as Splice);
    out[key] = replacement ? replacement[0] : rewrite(value, expansions);
  }
  return out;
}
