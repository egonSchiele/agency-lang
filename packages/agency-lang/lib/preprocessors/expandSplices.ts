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
 * AST in, AST out. An earlier design returned printed source with an
 * obligation on the caller to write it to disk, which rewrote the user's
 * own file on the build path and destroyed every source position below the
 * splice. Pasting nodes keeps positions intact and keeps `loc.origin`
 * stamps alive, which is the thing splices have that `toSource` →
 * `runCode` does not.
 *
 * The work happens in three phases that must not interleave, because they
 * change for different reasons:
 *
 *   1. DECIDE — may this generator run at all? An ordered list of checks.
 *   2. RUN — produce the fragment. Not a check; it returns a value.
 *   3. GRAFT — does the fragment fit this position, and paste it in.
 *
 * The kind check lives in phase 3 rather than phase 1 precisely because it
 * needs the result, which is why phase 1 cannot simply be "all the checks".
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
  // walks files and may arrive back here. Without this guard a file that
  // reached itself would recurse until the stack ran out.
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
 * `walkNodesArray` does not descend into a code literal, and that is what
 * leaves a splice inside `[| ... |]` alone. The literal's body belongs to
 * the program being GENERATED, not to this one, so a splice in there is
 * the generated program's business — the same leaf-ness rule that keeps
 * quoted names out of the host scope.
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
  // Object identity is the map key, so a splice is matched by BEING the
  // node rather than by its position — which is what survives a decl
  // splice spreading N nodes and shifting every index after it.
  const expansions = new Map<Splice, AgencyNode[]>();
  // Grows as splices expand, so the second splice in a file cannot
  // redeclare what the first one generated either.
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
    // A cached failure carries the position of whichever splice ran first.
    // Re-anchor it, or the editor underlines the wrong line.
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

/**
 * The eligibility rules, in order, each answering the same question shape:
 * is there a reason this may not run? Adding a rule later — a cap on
 * generated output size, say — is an entry in this array rather than an
 * edit to the pass.
 */
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
  // Resolving PRODUCES the module and name, so it is not one of the checks
  // above even though it can fail. Its result is what they are checked
  // against.
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
  // Short-circuiting reduce, not `.map().find()`: each check parses the
  // generator's whole import closure, so running them all would multiply
  // that cost by the number of rules.
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
 * A splice's arguments are evaluated before this file exists, so they
 * cannot mention anything this file declares.
 *
 * The generator runs in a separate compile of a separate program. A
 * constant defined in the host has not been compiled, let alone
 * evaluated, when that happens. Literals and code literals are fine, and
 * so is an imported name — a code literal contributes no free names at
 * all, since `walkNodesArray` treats it as a leaf.
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
 * This rule exists because a claim the design rested on turned out to be
 * false. The argument for declaration splices being safe was that a
 * generated `const config` colliding with an existing one would be a
 * duplicate-declaration error, so a collision could not pass unnoticed.
 * Measured against the real compiler, that is true for functions and NOT
 * true for constants: two top-level `const config` declarations compile
 * fine and the later one silently wins.
 *
 * So the guarantee is enforced here instead of assumed. Refusing costs a
 * generator nothing — it can pick another name — while last-wins would let
 * generated code quietly replace something the author wrote.
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

/**
 * Check the fragment fits this position, then stamp and hand back the
 * nodes to paste.
 *
 * The position/kind rule is the shared one from `graft.ts`, so a splice
 * and a template hole cannot disagree about what fits where.
 */
/**
 * Generated code may reference only names it declares itself and names it
 * imports. Anything else is AG8010.
 *
 * The problem this closes is worst in expression position: dropping a
 * generated expression into a function body puts it next to that
 * function's locals, and a generated mention of `tmp` would silently read
 * the local `tmp` — a name the generator's author never saw.
 *
 * Renaming, which is what `hygiene.ts` does for template fills, is the
 * WRONG fix here. A declaration splice exists so that `greet` keeps its
 * name; renaming it away would defeat the whole point. So this is a
 * checking rule, and it fails closed: a generated `const` does share the
 * enclosing scope once pasted, and what the rule prevents is a generator
 * reaching INTO the splice site rather than sharing a scope with it.
 *
 * Names the fragment imports come from the FRAGMENT's own import lines,
 * never the host's. A generator that wants `z` must emit `import { z }`
 * itself; inheriting the host's imports would make generated code depend
 * on the file it happens to land in.
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
 * callee as a plain string on `functionCall`, so calls are invisible to
 * it. Without this the rule would let generated code call anything at the
 * splice site while carefully refusing to read a variable there — half a
 * rule, and the wrong half, since calling a host helper is the more
 * natural mistake.
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
 * This is the shared hole table from `graft.ts` with one deliberate
 * difference: a declaration splice also accepts a `statements` fragment.
 *
 * Kind inference for code literals is smallest-first, so a literal holding
 * only `const config = "x"` stops at `statements` and never reaches
 * `program`. Requiring `program` would therefore make generating top-level
 * constants impossible — the most obvious thing a declaration splice is
 * for. At the top level of a program a statement IS a declaration, so
 * accepting it costs nothing. A template hole keeps the stricter rule,
 * where `decl` means a declaration position specifically.
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
 * In an array a splice spreads — a declaration splice can produce several
 * declarations. Everywhere else it must be exactly one node, which the
 * kind check has already guaranteed by requiring an `expr` fragment, and
 * an `expr` fragment holds one node.
 *
 * Code literals are copied through untouched: their contents belong to the
 * generated program, not this one.
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
