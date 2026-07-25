import { kindOf } from "./code.js";
import type { Code } from "./code.js";
import type { SourceLocation } from "../../types/base.js";

/**
 * What the two ways of grafting Agency code into other Agency code have in
 * common: filling a hole (`fill.ts`) and expanding a compile-time splice
 * (`expandSplices.ts`).
 *
 * They differ in almost everything else — one runs at template-fill time
 * against a `Hole`, the other during compilation against a `Splice` — but
 * they answer the same two questions, and the answers must not drift apart.
 * Origin stamping in particular is the detail that goes stale first once
 * there are two copies of it, and it is what makes an error inside
 * generated code attributable at all.
 */

/** Who a grafted node came from. */
export type CodeOrigin = NonNullable<SourceLocation["origin"]>;

/**
 * Which fragment kinds may fill each syntactic position.
 *
 * A hole's `sort` and a splice's position are the same question asked
 * twice: what shape of code fits here?
 */
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
 * Stamp `origin` onto EVERY node of a grafted fragment, not just the top.
 *
 * A fragment's inner nodes carry positions into a source that no longer
 * exists — a template string, or a generator's own file — so an error
 * there must still say where the code came from. Recurses the whole tree,
 * deep-cloning as it goes, which also protects against aliasing the
 * caller's value.
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
  // Only nodes that already carry a position get the stamp — their loc
  // points into a source that no longer exists, so the origin marker is
  // what keeps an error there attributable. Loc-less sub-records (text
  // segments and the like) keep their exact shape.
  if (source.loc !== undefined) {
    out.loc = { ...(source.loc as SourceLocation), origin };
  }
  return out;
}
