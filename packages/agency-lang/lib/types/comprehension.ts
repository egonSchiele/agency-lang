import type { Expression } from "../types.js";
import type { BaseNode } from "./base.js";
import type { ArrayPattern, ObjectPattern } from "./pattern.js";

/** A list comprehension, `[expr for x in xs if cond]`, or its concurrent
 *  form `fork [expr for x in xs if cond]` (spec:
 *  docs/superpowers/specs/2026-07-18-list-comprehensions-design.md).
 *
 *  The binder fields mirror ForLoop deliberately: `itemVar` may be a name
 *  or a destructuring pattern, and `indexVar` is the optional second
 *  binder, meaning the index for arrays and the value for objects.
 *  Reusing that shape means the comprehension inherits the loop's
 *  semantics rather than inventing its own.
 *
 *  Lifecycle: the parser and agencyGenerator (for `agency fmt`) see this
 *  node; comprehensionDesugar rewrites it into map/filter/fork calls
 *  inside parseAgency's `lower` block, so the checker, the builder, and
 *  the runtime never see it. */
export type Comprehension = BaseNode & {
  type: "comprehension";
  expression: Expression;
  itemVar: string | ObjectPattern | ArrayPattern;
  indexVar?: string;
  iterable: Expression;
  condition?: Expression;
  /** Which call the comprehension desugars to: "seq" lowers to `map`,
   *  the other two lower to the call of the same name. */
  mode: "seq" | "fork" | "race";
  /** True for the `forkShared`/`raceShared` prefixes. Non-optional so
   *  the invariant "seq is never shared" is carried by the prefix table
   *  (SEQ_PREFIX below) rather than by a comment. Lowers to a
   *  `shared: true` named argument on the desugared call, which
   *  processForkCall already understands. */
  shared: boolean;
};

/** Comprehension concurrency prefixes: keyword -> node fields. The
 *  parser matches these keywords; the formatter prints them back via
 *  comprehensionPrefixString, a reverse lookup over this SAME table.
 *  Adding a prefix is one row here plus one str(...) in the parser's
 *  or(...) (longest keyword first). Neither word is reserved - they are
 *  only special immediately before a comprehension bracket. */
export const COMPREHENSION_PREFIXES: Record<
  string,
  { mode: "fork" | "race"; shared: boolean }
> = {
  fork: { mode: "fork", shared: false },
  forkShared: { mode: "fork", shared: true },
  race: { mode: "race", shared: false },
  raceShared: { mode: "race", shared: true },
};

/** The no-prefix (sequential) fields. A table row, not a special case in
 *  the parser: seq carries shared: false because this says so. */
export const SEQ_PREFIX: { mode: "seq"; shared: boolean } = {
  mode: "seq",
  shared: false,
};

/** fields -> keyword, for the formatter. Reverse lookup over
 *  COMPREHENSION_PREFIXES so a prefix that parses always prints back as
 *  itself. Throws on an unprintable combination rather than emitting
 *  source text that would not re-parse. */
export function comprehensionPrefixString(
  node: Pick<Comprehension, "mode" | "shared">,
): string {
  if (node.mode === "seq") {
    return "";
  }
  const entry = Object.entries(COMPREHENSION_PREFIXES).find(
    ([, fields]) =>
      fields.mode === node.mode && fields.shared === node.shared,
  );
  if (entry === undefined) {
    throw new Error(
      `no comprehension prefix spells mode=${node.mode} shared=${node.shared}`,
    );
  }
  return `${entry[0]} `;
}
