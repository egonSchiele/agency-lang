import path from "node:path";
import { walkNodesArray } from "../utils/node.js";
import { generateExpression } from "../backends/agencyGenerator.js";
import { declaredName } from "../types/hole.js";
import { bindersOf, freeNamesOf } from "../runtime/template/hygiene.js";
import { BUILTIN_VARIABLES } from "../config.js";
import { PRELUDE_NAMES } from "../prelude.js";
import { BUILTIN_FUNCTION_TYPES } from "../typeChecker/builtins.js";
import { KINDS_FOR_SORT, stampOrigin } from "../runtime/template/graft.js";
import { kindOf } from "../runtime/template/code.js";
import {
  checkGeneratorEligible,
  resolveGeneratorModule,
} from "../compiler/splice/eligibility.js";
import { runGenerator } from "../compiler/splice/runGenerator.js";
import { cachedGeneratorRun, spliceCacheKey } from "../compiler/splice/cache.js";
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

export function expandSplices(
  program: AgencyProgram,
  hostPath: string,
  config: AgencyConfig = {},
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
    return expandAll(program, splices, hostPath, config);
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
): SpliceResult<AgencyProgram> {
  const hostNames = declaredNamesIn(program);
  // Keyed by object identity, not position. A declaration splice spreads N
  // nodes and shifts the index of every splice after it.
  const expansions = new Map<Splice, AgencyNode[]>();
  // Grows as splices expand, so one splice cannot redeclare what an
  // earlier one generated.
  const taken = [...hostNames];

  for (const splice of splices) {
    const expanded = expandOne(splice, program, hostPath, config, hostNames);
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
  hostNames: string[],
): SpliceResult<AgencyNode[]> {
  const decided = decide(splice, program, hostPath, config, hostNames);
  if (!decided.ok) {
    return decided;
  }
  const { generator } = decided.value;

  const expression = generateExpression(splice.expression);
  const produced = cachedGeneratorRun(
    spliceCacheKey(expression, generator.modulePath, config),
    () =>
      runGenerator(splice, generator, path.dirname(path.resolve(hostPath)), {
        config,
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
// Phase 1: decide
// ---------------------------------------------------------------------------

type DecisionContext = {
  splice: Splice;
  localName: string;
  generator: { modulePath: string; exportedName: string };
  config: AgencyConfig;
  hostNames: string[];
};

/** The eligibility rules, in order. Adding one later means adding an entry
 *  here rather than editing the pass. */
const CHECKS: ReadonlyArray<(ctx: DecisionContext) => SpliceDiagnostic | null> = [
  checkArgumentsAvailable,
  ({ generator, config }) =>
    checkGeneratorEligible(generator.modulePath, generator.exportedName, config),
];

function decide(
  splice: Splice,
  program: AgencyProgram,
  hostPath: string,
  config: AgencyConfig,
  hostNames: string[],
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

  const ctx: DecisionContext = {
    splice,
    localName,
    generator: resolved.value,
    config,
    hostNames,
  };
  // Short-circuiting, not `.map().find()`. Each check parses the
  // generator's whole import closure.
  const failure = CHECKS.reduce<SpliceDiagnostic | null>(
    (found, check) => found ?? check(ctx),
    null,
  );
  return failure === null
    ? { ok: true, value: ctx }
    : { ok: false, diagnostic: { ...failure, loc: splice.loc ?? ORIGIN_UNKNOWN } };
}

/** A splice calls its generator; anything else has no generator to name. */
function calleeName(splice: Splice): string | null {
  const expression = splice.expression as { type: string; functionName?: string };
  return expression.type === "functionCall" && expression.functionName !== undefined
    ? expression.functionName
    : null;
}

/**
 * A splice's arguments run before this file exists, so they cannot mention
 * anything it declares. Literals, code literals, and imported names are
 * all fine.
 */
function checkArgumentsAvailable({
  splice,
  hostNames,
}: DecisionContext): SpliceDiagnostic | null {
  const free = freeNamesOf({
    type: "agencyProgram",
    kind: "expr",
    nodes: [splice.expression as AgencyNode],
  });
  const clash = free.find((name) => hostNames.includes(name));
  return clash === undefined
    ? null
    : {
        diagnostic: "spliceArgumentNotAvailable",
        params: { name: clash },
        loc: splice.loc ?? ORIGIN_UNKNOWN,
      };
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

/** Local names a fragment's own import lines bind. */
function importedNamesIn(nodes: AgencyNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type !== "importStatement") return [];
    return node.importedNames.flatMap((group) => {
      if (group.type !== "namedImport") return [];
      const aliases = group.aliases ?? {};
      return group.importedNames
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => (Object.hasOwn(aliases, entry) ? aliases[entry] : entry));
    });
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
const KINDS_FOR_POSITION: Record<Splice["position"], string[]> = {
  decl: [...KINDS_FOR_SORT.decl, "statements"],
  expr: KINDS_FOR_SORT.expr,
};

function graft(
  splice: Splice,
  code: Code,
  generatorName: string,
): SpliceResult<AgencyNode[]> {
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
          expected: splice.position === "decl" ? "program" : "expr",
          position: splice.position === "decl" ? "declaration" : "expression",
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
