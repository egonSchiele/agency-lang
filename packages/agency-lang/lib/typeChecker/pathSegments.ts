import type { AccessChainElement } from "../types/access.js";

/**
 * Pure path-segment core, split out of `flow.ts` so both `flow.ts` and
 * `narrowing.ts` can VALUE-import it without forming a runtime cycle (`flow.ts`
 * value-imports `narrowByRefine` from `narrowing.ts`; `narrowing.ts` needs
 * `chainToSegments`). No dependency on the flow graph, scopes, or narrowing.
 */

/**
 * One hop of a narrowed access path. A `prop` is a static property name; an
 * `index` is a LITERAL array index. They are kept distinct so `box.r` (property
 * "r") and `arr[0]` (index 0) — and a numeric property `obj["0"]` vs `arr[0]` —
 * never alias in `referenceKey`/`isPrefixOf`. The chain is reserved for stable
 * paths only: calls, computed keys, slices, and method hops never appear here
 * (the recognizers reject them).
 */
export type PathSegment =
  | { kind: "prop"; name: string }
  | { kind: "index"; index: number };

/**
 * A normalized reference path — the bound thing being narrowed. A bare variable
 * is the empty-chain case; member paths (`box.r`, `arr[0]`, `a.b.c`) carry their
 * hops as `PathSegment`s.
 */
export type Reference = { variable: string; chain: PathSegment[] };

/** Stable string key for one path hop. `prop` → its name; `index` → `[N]`. */
export function segKey(seg: PathSegment): string {
  return seg.kind === "prop" ? seg.name : `[${seg.index}]`;
}

/** Stable string key for a reference (map keys, equality). */
export function referenceKey(ref: Reference): string {
  return ref.chain.length === 0
    ? ref.variable
    : `${ref.variable}.${ref.chain.map(segKey).join(".")}`;
}

function segEq(a: PathSegment, b: PathSegment): boolean {
  // Discriminated compare — no nested ternary (docs/dev/anti-patterns.md).
  if (a.kind !== b.kind) return false;
  if (a.kind === "prop") return a.name === (b as { name: string }).name;
  return a.index === (b as { index: number }).index;
}

/**
 * True if `prefix` is a proper prefix of `path` (same variable; `prefix.chain`
 * is a leading sub-sequence of `path.chain`). Used for prefix invalidation:
 * reassigning `box` (or `box.r`) drops a narrowing on `box.r` (or `box.r.value`).
 */
export function isPrefixOf(prefix: Reference, path: Reference): boolean {
  if (prefix.variable !== path.variable) return false;
  if (prefix.chain.length >= path.chain.length) return false;
  return prefix.chain.every((seg, i) => segEq(seg, path.chain[i]));
}

/**
 * One access-chain hop → a path segment, or null if the hop is UNSTABLE (a
 * computed/non-literal-integer index, a slice, or a method call). Stable hops:
 * a property, or a literal non-negative-integer index. THE single source of the
 * stability rule — `chainToSegments` and `stablePrefix` both build on it.
 */
export function toSegment(el: AccessChainElement): PathSegment | null {
  if (el.kind === "property") return { kind: "prop", name: el.name };
  if (el.kind === "index" && el.index.type === "number") {
    const n = Number(el.index.value); // NumberLiteral.value is a string
    if (!Number.isInteger(n) || n < 0) return null;
    return { kind: "index", index: n };
  }
  return null; // computed index, slice, methodCall
}

/** Whole chain → segments, or null if ANY hop is unstable. */
export function chainToSegments(elements: AccessChainElement[]): PathSegment[] | null {
  const segs: PathSegment[] = [];
  for (const el of elements) {
    const seg = toSegment(el);
    if (seg === null) return null;
    segs.push(seg);
  }
  return segs;
}

/**
 * The maximal STABLE prefix — stops at the first unstable hop instead of
 * nulling the whole chain. A later unstable hop must NOT block narrowing an
 * earlier stable prefix (`a.b[i()].x` can still use a narrowed `a.b`).
 */
export function stablePrefix(elements: AccessChainElement[]): PathSegment[] {
  const segs: PathSegment[] = [];
  for (const el of elements) {
    const seg = toSegment(el);
    if (seg === null) break;
    segs.push(seg);
  }
  return segs;
}
