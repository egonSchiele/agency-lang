/**
 * The `__matchval_<id>` naming contract for expression-position `match`.
 *
 * A match expression lowers to a hoisted region that stores its result in a
 * synthetic frame-local, which the consumer (`return match(...)` /
 * `const x = match(...)`) then reads. Several layers touch this name — the
 * runtime writes it (`Runner.exitMatch`), pattern lowering builds the read
 * reference, the TS builder emits the plain-mode write and resolves the read,
 * and the type checker recognizes the ref to type it. A typo at any one site
 * produces a silently-`undefined` match value rather than an error, so all of
 * them go through these helpers instead of hand-spelling the prefix.
 */

const MATCHVAL_RE = /^__matchval_(\d+)$/;

/** The frame-local name holding the result of the match with the given id. */
export function matchValName(id: number): string {
  return `__matchval_${id}`;
}

/** Whether `name` is a `__matchval_<id>` synthetic temp. */
export function isMatchValName(name: string): boolean {
  return MATCHVAL_RE.test(name);
}

/** The match id when `name` is a `__matchval_<id>` ref, else `undefined`. */
export function parseMatchValId(name: string): number | undefined {
  const m = MATCHVAL_RE.exec(name);
  return m ? Number(m[1]) : undefined;
}
