import { AgencyNode, Hole, StringLiteral } from "../../types.js";
import { SourceLocation } from "../../types/base.js";
import { LEGAL_IDENTIFIER, RESERVED_WORDS } from "../../parsers/parsers.js";
import { holeNames, positionInferredTypes } from "../../utils/holes.js";
import { variableTypeToString } from "../../backends/typescriptGenerator/typeToString.js";
import { Code, isCode, kindOf } from "./code.js";
import { liftValue } from "./lift.js";
import {
  RESERVED_PREFIX,
  applyRenames,
  applyScopedRenames,
  assertNoReservedPrefix,
  computeRenames,
} from "./hygiene.js";

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
      throw new Error(
        `\`${name}\` is not a hole in this template. Its holes are: ${present.join(", ") || "(none)"}.`,
      );
    }
  }

  // Hygiene, one declarative sequence: reject reserved-prefix input,
  // compute the rename plan, rename the template within the affected
  // scopes, rename each filler within itself, then substitute.
  assertNoReservedPrefix(code, "template");
  for (const value of Object.values(values)) {
    if (isCode(value)) assertNoReservedPrefix(value, "filler");
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isCode(item)) assertNoReservedPrefix(item, "filler");
      }
    }
  }
  const plan = computeRenames(code, values);
  const renamedTemplate = applyScopedRenames(code, plan.template);
  const renamedValues: Record<string, unknown> = {};
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

  // Expected types for fill-time validation: the hole's annotation, or
  // the type its position supplies.
  const expected: Record<string, string> = positionInferredTypes(renamedTemplate.nodes);

  return {
    ...renamedTemplate,
    nodes: substituteInArray(renamedTemplate.nodes, renamedValues, expected) as AgencyNode[],
  };
}

function isFillableHole(value: unknown, values: Record<string, unknown>): value is Hole {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: string }).type === "hole" &&
    (value as Hole).name in values
  );
}

/** Sequence positions (statement bodies, argument lists, import-specifier
 *  lists): a fill may expand to several items, spread into the sequence. */
function substituteInArray(
  items: unknown[],
  values: Record<string, unknown>,
  expected: Record<string, string>,
): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    if (isFillableHole(item, values)) {
      const replacement = fillOne(item, values[item.name], expected);
      if (Array.isArray(replacement)) out.push(...replacement);
      else out.push(replacement);
    } else {
      out.push(substituteAny(item, values, expected));
    }
  }
  return out;
}

/** Single-value positions (an assignment's value, a declaration's name):
 *  a fill must produce exactly one item here. */
function substituteAny(
  value: unknown,
  values: Record<string, unknown>,
  expected: Record<string, string>,
): unknown {
  if (Array.isArray(value)) return substituteInArray(value, values, expected);
  if (value === null || typeof value !== "object") return value;
  if (isFillableHole(value, values)) {
    const replacement = fillOne(value, values[value.name], expected);
    if (Array.isArray(replacement)) {
      if (replacement.length === 1) return replacement[0];
      throw new Error(
        `The hole \`#${value.name}\` takes a single item, but the fill produced ${replacement.length}.`,
      );
    }
    return replacement;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = substituteAny(source[key], values, expected);
  }
  return out;
}

function fillOne(
  hole: Hole,
  value: unknown,
  expected: Record<string, string>,
): string | AgencyNode | AgencyNode[] {
  if (hole.sort === "identifier") return identifierFillFor(hole, value);
  const expectedType =
    hole.typeAnnotation !== undefined
      ? variableTypeToString(hole.typeAnnotation, {}, true)
      : expected[hole.name];
  if (hole.splice) {
    if (!Array.isArray(value)) {
      throw new Error(`The splice \`#...${hole.name}\` needs an array.`);
    }
    return value.flatMap((item) => nodesFor(hole, item, expectedType));
  }
  const nodes = nodesFor(hole, value, expectedType);
  if (hole.sort === "expr") {
    if (nodes.length !== 1) {
      throw new Error(
        `The hole \`#${hole.name}\` takes a single expression, but got ${nodes.length} items.`,
      );
    }
    return nodes[0];
  }
  return nodes;
}

function nodesFor(hole: Hole, value: unknown, expectedType?: string): AgencyNode[] {
  if (expectedType) assertFillerType(hole, value, expectedType);
  if (isCode(value)) {
    assertKindMatchesSort(value, hole);
    return value.nodes.map((node) => stampOrigin(node, hole));
  }
  return [liftValue(value, fillerLoc(hole))];
}

/**
 * Fill-time type VALIDATION — deliberately not a compile-time guarantee.
 * Rejects only when both sides are certainly-known primitives that differ:
 * a plain JS value's type is immediate, and a literal expression fragment's
 * type is its literal kind. Anything else (calls, names, complex expected
 * types) passes here and is caught by the completed program's full check
 * at run time. Checking fragments against the completed program's module
 * scope needs a checker entry point that does not exist yet; when it does,
 * this narrows.
 */
function assertFillerType(hole: Hole, value: unknown, expectedType: string): void {
  const actual = certainTypeOf(value);
  if (actual === null) return;
  const primitives = ["string", "number", "boolean"];
  if (!primitives.includes(expectedType)) return;
  if (actual !== expectedType) {
    throw new Error(
      `The hole \`#${hole.name}\` expects \`${expectedType}\`, but the fill supplies \`${actual}\` (in the fill for \`#${hole.name}\`).`,
    );
  }
}

/** The value's type when it is knowable without a checker, else null. */
function certainTypeOf(value: unknown): string | null {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (isCode(value) && kindOf(value) === "expr" && value.nodes.length === 1) {
    const node = value.nodes[0];
    if (node.type === "number") return "number";
    if (node.type === "boolean") return "boolean";
    if (node.type === "string") {
      const literal = node as StringLiteral;
      const interpolated = literal.segments.some((s) => s.type === "interpolation");
      return interpolated ? null : "string";
    }
  }
  return null;
}

function assertKindMatchesSort(code: Code, hole: Hole): void {
  const kind = kindOf(code);
  const allowed: Record<Hole["sort"], string[]> = {
    expr: ["expr"],
    statements: ["statements", "program"],
    decl: ["program"],
    identifier: [],
  };
  if (!allowed[hole.sort].includes(kind)) {
    throw new Error(
      `The hole \`#${hole.name}\` has sort \`${hole.sort}\`, which a \`${kind}\` Code fragment cannot fill.`,
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
      `\`${String(value)}\` is not a legal identifier, so it cannot fill \`#${hole.name}\`.`,
    );
  }
  if (RESERVED_WORDS.includes(value)) {
    throw new Error(
      `\`${value}\` is a reserved word, so it cannot fill \`#${hole.name}\`.`,
    );
  }
  if (value.startsWith(RESERVED_PREFIX)) {
    throw new Error(
      `\`${value}\` uses the reserved prefix \`${RESERVED_PREFIX}\`, so it cannot fill \`#${hole.name}\`.`,
    );
  }
  return value;
}

function fillerLoc(hole: Hole): SourceLocation {
  return { ...hole.loc, origin: { kind: "filler", name: hole.name } };
}

function stampOrigin(node: AgencyNode, hole: Hole): AgencyNode {
  const withLoc = node as AgencyNode & { loc?: SourceLocation };
  return {
    ...node,
    loc: { ...(withLoc.loc ?? hole.loc), origin: { kind: "filler" as const, name: hole.name } },
  } as AgencyNode;
}
