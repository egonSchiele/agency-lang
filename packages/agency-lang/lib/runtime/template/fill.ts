import {
  AgencyNode,
  ArrayType,
  Hole,
  TypeAliasEntry,
  VariableType,
} from "../../types.js";
import { SourceLocation } from "../../types/base.js";
import { LEGAL_IDENTIFIER, RESERVED_WORDS } from "../../parsers/parsers.js";
import {
  findHoles,
  holeNames,
  positionInferredVariableTypes,
} from "../../utils/holes.js";
import { variableTypeToString } from "../../backends/typescriptGenerator/typeToString.js";
import { isAssignable, safeResolveType } from "../../typeChecker/assignability.js";
import { visitTypes } from "../../typeChecker/typeWalker.js";
import { isBuiltinGenericName } from "../../typeChecker/builtinGenerics.js";
import { aliasTableFrom } from "./aliasTable.js";
import { synthesizeType } from "./synthesizeType.js";
import { explainMismatch } from "./explainMismatch.js";
import { Code, isCode, kindOf } from "./code.js";
import { kindFitsSort, stampOrigin } from "./origin.js";
import { liftValue } from "./lift.js";
import {
  RESERVED_PREFIX,
  applyRenames,
  applyScopedRenames,
  computeRenames,
} from "./hygiene.js";

/** Attribution for errors that anchor to a node carried in by a graft:
 *  its loc.origin (stamped by stampOrigin) names the fill the node most
 *  recently arrived through — re-grafting overwrites the stamp, so in a
 *  nested composition the OUTERMOST graft wins, which is the one the
 *  current caller performed and can act on. Best-effort: loc-less inner
 *  nodes carry no stamp and get no suffix. Only the fill path can read
 *  this — toSource/runCode re-parse from text, which drops loc entirely;
 *  compile-side attribution needs the fragment-checker entry point
 *  (recorded follow-up). */
function originSuffix(loc: SourceLocation | undefined): string {
  if (!loc?.origin || loc.origin.kind !== "filler") return "";
  return ` (in code grafted by the fill for \`#${loc.origin.name}\`)`;
}

/**
 * Substituting values into a template's holes. The rules, in order of how
 * much damage getting them wrong would do:
 *
 * - Plain values are LIFTED to literal nodes and never parsed. Filling a
 *   string hole with `readFile("/etc/passwd")` yields a string literal
 *   containing those characters, not a call.
 * - `Code` values graft as trees, with fragment kind checked against the
 *   hole's sort.
 * - Identifier holes are the one exception to lifting: the filler string
 *   becomes a NAME, so it is validated against the identifier grammar,
 *   the reserved words, and the hygiene prefix.
 * - A partially filled template is an ordinary Code value; grafting it
 *   carries its remaining holes along, and a later fill completes them.
 *   Build the shape first, parameterize last — this is the feature's core
 *   workflow, so nothing here may reject Code containing holes.
 */
export function fillHoles(code: Code, values: Record<string, unknown>): Code {
  const present = holeNames(code.nodes);
  for (const name of Object.keys(values)) {
    if (!present.includes(name)) {
      // Only the error message needs per-hole origin, so the second walk
      // happens on the failure path only.
      const holes = findHoles(code.nodes);
      const listed = present
        .map((holeName) => {
          const hole = holes.find((candidate) => candidate.name === holeName) as Hole;
          const origin = hole.loc?.origin;
          return origin && origin.kind === "filler"
            ? `#${holeName} (from the fill for \`#${origin.name}\`)`
            : `#${holeName}`;
        })
        .join(", ");
      throw new Error(
        `\`${name}\` is not a hole in this template. Its holes are: ${listed || "(none)"}.`,
      );
    }
  }

  // Hygiene, one declarative sequence: compute the rename plan (whose
  // fresh-name counter is seeded above every __hyg index already present,
  // so a re-fill of previously renamed output composes instead of
  // colliding), rename the template within the affected scopes, rename
  // each filler within itself, then substitute.
  const plan = computeRenames(code, values);
  const renamedTemplate = applyScopedRenames(code, plan.template);
  // Null-prototype: keyed by user-controlled hole names.
  const renamedValues: Record<string, unknown> = Object.create(null);
  for (const [name, value] of Object.entries(values)) {
    if (isCode(value)) {
      renamedValues[name] = applyRenames(value, plan.fillers[name] ?? {});
    } else if (Array.isArray(value)) {
      renamedValues[name] = value.map((item, index) =>
        isCode(item) ? applyRenames(item, plan.fillers[`${name}[${index}]`] ?? {}) : item,
      );
    } else {
      renamedValues[name] = value;
    }
  }

  // Everything fill-time validation needs: the type each hole's position
  // supplies, and the template's own aliases to resolve names against.
  const types: FillTypes = {
    expected: positionInferredVariableTypes(renamedTemplate.nodes),
    aliases: aliasTableFrom(renamedTemplate.nodes),
  };

  return {
    ...renamedTemplate,
    nodes: substituteInArray(renamedTemplate.nodes, renamedValues, types) as AgencyNode[],
  };
}

function isFillableHole(value: unknown, values: Record<string, unknown>): value is Hole {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: string }).type === "hole" &&
    // Own-property check: a hole named "toString" or "constructor" must
    // not read Object.prototype through `in`.
    Object.hasOwn(values, (value as Hole).name)
  );
}

/** Sequence positions (statement bodies, argument lists, import-specifier
 *  lists): a fill may expand to several items, spread into the sequence. */
function substituteInArray(
  items: unknown[],
  values: Record<string, unknown>,
  types: FillTypes,
): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    if (isFillableHole(item, values)) {
      const replacement = fillOne(item, values[item.name], types);
      if (Array.isArray(replacement)) out.push(...replacement);
      else out.push(replacement);
    } else {
      out.push(substituteAny(item, values, types));
    }
  }
  return out;
}

/** Single-value positions (an assignment's value, a declaration's name):
 *  a fill must produce exactly one item here. */
function substituteAny(
  value: unknown,
  values: Record<string, unknown>,
  types: FillTypes,
): unknown {
  if (Array.isArray(value)) return substituteInArray(value, values, types);
  if (value === null || typeof value !== "object") return value;
  if (isFillableHole(value, values)) {
    const replacement = fillOne(value, values[value.name], types);
    if (Array.isArray(replacement)) {
      if (replacement.length === 1) return replacement[0];
      throw new Error(
        `The hole \`#${value.name}\` takes a single item, but the fill produced ${replacement.length}${originSuffix(value.loc)}.`,
      );
    }
    return replacement;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = substituteAny(source[key], values, types);
  }
  return out;
}

function fillOne(
  hole: Hole,
  value: unknown,
  types: FillTypes,
): string | AgencyNode | AgencyNode[] {
  if (hole.sort === "identifier") return identifierFillFor(hole, value);
  // An inline annotation on the hole wins over the type its position
  // supplies; neither is required.
  const expectedType = hole.typeAnnotation ?? types.expected[hole.name];
  if (hole.splice) {
    if (!Array.isArray(value)) {
      throw new Error(`The splice \`#...${hole.name}\` needs an array${originSuffix(hole.loc)}.`);
    }
    return value.flatMap((item) => nodesFor(hole, item, types, expectedType));
  }
  const nodes = nodesFor(hole, value, types, expectedType);
  if (hole.sort === "expr") {
    if (nodes.length !== 1) {
      throw new Error(
        `The hole \`#${hole.name}\` takes a single expression, but got ${nodes.length} items${originSuffix(hole.loc)}.`,
      );
    }
    return nodes[0];
  }
  return nodes;
}

function nodesFor(
  hole: Hole,
  value: unknown,
  types: FillTypes,
  expectedType?: VariableType,
): AgencyNode[] {
  if (expectedType !== undefined) {
    assertFillerType(hole, value, expectedType, types.aliases);
  }
  if (isCode(value)) {
    assertKindMatchesSort(value, hole);
    // Deep-stamp the fragment, then guarantee the TOP node of each graft
    // carries a stamped loc even when the fragment parser attached none
    // (small literals parse loc-less) — the hole's own position is the
    // honest fallback.
    return value.nodes.map((node) => {
      const stamped = stampOrigin(node, { kind: "filler", name: hole.name }) as AgencyNode & {
        loc?: SourceLocation;
      };
      if (stamped.loc === undefined) stamped.loc = fillerLoc(hole);
      return stamped as AgencyNode;
    });
  }
  return [liftValue(value, fillerLoc(hole))];
}

/** What fill-time validation needs, threaded as one value so the
 *  substitution walkers do not grow a parameter per lookup table. */
type FillTypes = {
  /** Hole name -> the type its position supplies. An inline annotation on
   *  the hole itself wins over this; see `fillOne`. */
  expected: Record<string, VariableType>;
  /** The template's own type aliases, for resolving a named type. */
  aliases: Record<string, TypeAliasEntry>;
};

/**
 * Fill-time type validation — not a compile-time guarantee.
 *
 * THE INVARIANT: fill may only reject what the completed program's compile
 * would also reject. Missing things is fine. Refusing something that would
 * have compiled is not — the caller cannot argue with it.
 *
 * Both sides must be certainly known, so anything unknowable is skipped:
 * a value `synthesizeType` cannot describe, or a type that does not fully
 * resolve. Comparison is the checker's own `isAssignable`, never a local
 * reimplementation.
 */
function assertFillerType(
  hole: Hole,
  value: unknown,
  expectedType: VariableType,
  aliases: Record<string, TypeAliasEntry>,
): void {
  const actual = synthesizeType(value);
  if (actual === null) return;
  // An unknown alias resolves to itself and compares as "does not match",
  // so without this a template importing its types rejects every fill.
  if (hasUnresolvedName(expectedType, aliases)) return;
  if (isAssignable(actual, expectedType, aliases)) return;
  // The pass above widens strings, but the checker infers string LITERAL
  // types, so `"fast"` against `"fast" | "slow"` compiles yet does not fit.
  // Retrying literal-accurately can only turn a rejection into an
  // acceptance, and costs nothing on the success path.
  const literalAccurate = synthesizeType(value, { stringsAsLiterals: true });
  if (literalAccurate !== null && isAssignable(literalAccurate, expectedType, aliases)) {
    return;
  }

  const printedExpected = variableTypeToString(expectedType, {}, true);
  // safeResolveType: `resolveType` throws on an invalid generic form, which
  // would turn a validation message into an unhandled TypeError.
  const resolvedExpected = safeResolveType(expectedType, aliases);
  // A splice checks each ELEMENT against the annotation, so `#...items:
  // Person[]` rejects everything. Claim that only when the element fits one
  // level down — `#...rows: number[]` is legitimate, and a bad element
  // there deserves the ordinary message.
  if (
    hole.splice &&
    resolvedExpected.type === "arrayType" &&
    isAssignable(
      literalAccurate ?? actual,
      (resolvedExpected as ArrayType).elementType,
      aliases,
    )
  ) {
    const element = variableTypeToString(
      (resolvedExpected as ArrayType).elementType,
      {},
      true,
    );
    throw new Error(
      `The splice \`#...${hole.name}\` describes one element, not the array — its type should be \`${element}\`, not \`${printedExpected}\`${originSuffix(hole.loc)}.`,
    );
  }

  // Runs only after the rejection is decided; it annotates, never decides.
  const detail = explainMismatch(value, expectedType, aliases);
  if (detail !== null) {
    throw new Error(
      `The hole \`#${hole.name}\` expects \`${printedExpected}\`, but the fill ${detail}${originSuffix(hole.loc)}.`,
    );
  }

  const printedActual = variableTypeToString(actual, {}, true);
  throw new Error(
    `The hole \`#${hole.name}\` expects \`${printedExpected}\`, but the fill supplies \`${printedActual}\`${originSuffix(hole.loc)}.`,
  );
}

/**
 * True when any name in this type is one the alias table cannot resolve —
 * an imported type, a body-scoped alias, or an undeclared name.
 *
 * Over-reporting only means some fills go unchecked; under-reporting would
 * reject correct programs, so err toward reporting true. Imported types are
 * therefore never checked at fill: #719.
 */
function hasUnresolvedName(
  type: VariableType,
  aliases: Record<string, TypeAliasEntry>,
  seen: Set<string> = new Set(),
  bound: Set<string> = new Set(),
): boolean {
  return visitTypes(type, (inner) => {
    // Alias names are user-controlled keys, so membership is Object.hasOwn.
    let name: string | null = null;
    if (inner.type === "typeAliasVariable") {
      name = inner.aliasName;
    }
    if (inner.type === "genericType" && !isBuiltinGenericName(inner.name)) {
      name = inner.name;
    }
    if (name === null) return false;
    // `type Box<T>` refers to `T` by name, and `T` is not in the table.
    // Bound, not unresolved — otherwise every generic alias is skipped.
    if (bound.has(name)) return false;
    if (!Object.hasOwn(aliases, name)) return true;
    // `type Person = { pet: Animal }` resolves only if `Animal` does too.
    // The seen-set stops a recursive alias walking forever.
    if (seen.has(name)) return false;
    seen.add(name);
    // Bound names REPLACE rather than extend: one alias's parameters are
    // not in scope inside another's body.
    const entry = aliases[name];
    const bodyBound = new Set((entry.typeParams ?? []).map((param) => param.name));
    return hasUnresolvedName(entry.body, aliases, seen, bodyBound);
  });
}

function assertKindMatchesSort(code: Code, hole: Hole): void {
  if (!kindFitsSort(code, hole.sort)) {
    throw new Error(
      `The hole \`#${hole.name}\` has sort \`${hole.sort}\`, which a \`${kindOf(code)}\` Code fragment cannot fill${originSuffix(hole.loc)}.`,
    );
  }
}

/**
 * The one exception to the lifting rule: an identifier hole's filler
 * becomes a name, so it is the only place an injection could happen.
 * Everything that is not a plain, legal, non-reserved identifier is
 * rejected. Returns the string itself — declaration names and import
 * specifiers hold plain strings in the AST.
 */
function identifierFillFor(hole: Hole, value: unknown): string {
  if (typeof value !== "string" || !LEGAL_IDENTIFIER.test(value)) {
    throw new Error(
      `\`${String(value)}\` is not a legal identifier, so it cannot fill \`#${hole.name}\`${originSuffix(hole.loc)}.`,
    );
  }
  if (RESERVED_WORDS.includes(value)) {
    throw new Error(
      `\`${value}\` is a reserved word, so it cannot fill \`#${hole.name}\`${originSuffix(hole.loc)}.`,
    );
  }
  // Identifier fillers are caller-supplied strings by definition — the
  // renamer only rewrites trees, never routes through this path — so a
  // reserved-prefix name here is always the caller's, and the fresh-name
  // counter seeding cannot see plain-string values. Reject.
  if (value.startsWith(RESERVED_PREFIX)) {
    throw new Error(
      `\`${value}\` uses the reserved prefix \`${RESERVED_PREFIX}\`, so it cannot fill \`#${hole.name}\`${originSuffix(hole.loc)}.`,
    );
  }
  return value;
}

function fillerLoc(hole: Hole): SourceLocation {
  return { ...hole.loc, origin: { kind: "filler", name: hole.name } };
}

