import { kindOf } from "./code.js";
import type { Code } from "./code.js";
import type { SourceLocation } from "../../types/base.js";

/**
 * Recording where a piece of generated code came from, so errors can name
 * it, plus the one table that says what shape of code fits where.
 *
 * Two features generate code: filling a hole in a template (`fill.ts`) and
 * expanding a compile-time splice (`expandSplices.ts`). They run at
 * different times against different node types, but they answer the same
 * two questions, and the answers must not drift apart.
 *
 * Without the origin stamp, a type error inside generated code points at
 * the user's file at code they never wrote, with nothing saying where it
 * came from.
 */

/** Who a grafted node came from. */
export type CodeOrigin = NonNullable<SourceLocation["origin"]>;

/** Which fragment kinds may fill each syntactic position. A hole's `sort`
 *  and a splice's position both ask what shape of code fits here. */
export const KINDS_FOR_SORT: Record<string, string[]> = {
  expr: ["expr"],
  // "expr" is admissible because an expression IS a legal statement in
  // Agency: an expression statement is the expression node itself in the
  // body array, so the graft is the identity. Whether a particular bare
  // expression is a MEANINGFUL statement is judged at the completed
  // program's compile — the right stage. `statements` already accepted
  // "program", so this closes the only gap smallest-first kind inference
  // for code literals leaves.
  statements: ["statements", "program", "expr"],
  decl: ["program"],
  identifier: [],
};

/** Does this fragment fit that position? */
export function kindFitsSort(code: Code, sort: string): boolean {
  return (KINDS_FOR_SORT[sort] ?? []).includes(kindOf(code));
}

/**
 * Stamp `origin` onto every node of a grafted fragment, not just the top.
 *
 * Inner nodes carry positions into a source that no longer exists, so an
 * error there must still say where the code came from. Deep-clones as it
 * recurses, which also avoids aliasing the caller's value.
 */
export function stampOrigin<T>(node: T, origin: CodeOrigin): T {
  return stampAny(node, origin) as T;
}

function stampAny(node: unknown, origin: CodeOrigin): unknown {
  if (Array.isArray(node)) return node.map((item) => stampAny(item, origin));
  if (node === null || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = key === "loc" ? source[key] : stampAny(source[key], origin);
  }
  // Only nodes that already carry a position get the stamp. Loc-less
  // sub-records like text segments keep their exact shape.
  if (source.loc !== undefined) {
    out.loc = { ...(source.loc as SourceLocation), origin };
  }
  return out;
}
