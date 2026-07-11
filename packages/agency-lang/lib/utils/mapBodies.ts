/**
 * mapBodies — apply a transform to every immediate statement body of a node,
 * returning a structurally-fresh copy with bodies replaced.
 *
 * Useful for AST passes that need to rewrite every block-bearing node
 * uniformly (lowering passes, instrumenting, scope analysis, …) without
 * hand-listing every body-bearing node type at every call site.
 *
 * The per-node-type body enumeration lives in `bodySlots` (bodySlots.ts) —
 * the same table `walkNodes` descends by — so a new node type registers its
 * bodies in one place and both read and rewrite pick it up.
 *
 * Shallow by design: only IMMEDIATE bodies are transformed. Callers that
 * want deep rewrites recurse inside their transform (see patternLowering's
 * `lowerBody`).
 */
import type { AgencyNode } from "../types.js";
import { bodySlots } from "./bodySlots.js";

export type BodyTransform = (body: AgencyNode[]) => AgencyNode[];

/** Return a shallow copy of `node` with every body transformed by `fn`. */
export function mapBodies(node: AgencyNode, fn: BodyTransform): AgencyNode {
  let out = node;
  for (const slot of bodySlots(node)) {
    const mapped = fn(slot.body);
    if (slot.single && mapped.length !== 1) {
      throw new Error(
        `mapBodies: a '${node.type}' wraps exactly one statement, but the ` +
          `transform returned ${mapped.length} statements`,
      );
    }
    out = slot.write(out, mapped);
  }
  return out;
}
