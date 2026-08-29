import type { AgencyNode } from "../types.js";
import type { Tag } from "../types/tag.js";
import type { EffectDeclaration } from "../types/effectDeclaration.js";

/** One node and the `@tag(...)` nodes written directly above it. `node` is
 *  null for tags at the end of a list, which nothing can own. */
export type NodeWithTagsAbove = { node: AgencyNode | null; tags: Tag[] };

/**
 * Pair every non-tag node with the tags written directly above it, at every
 * nesting level, without mutating anything. The preprocessor's `attachTags`
 * later moves those tags onto the node. The symbol table and the typechecker
 * run before that and see the raw list, so they use this to read tags the
 * same way codegen will. Mirrors `collectTypeAliasTags` in symbolTable.ts.
 */
export function tagsAbove(nodes: AgencyNode[]): NodeWithTagsAbove[] {
  const out: NodeWithTagsAbove[] = [];
  let pending: Tag[] = [];
  for (const node of nodes) {
    if (node.type === "tag") {
      pending = [...pending, node];
      continue;
    }
    out.push({ node, tags: pending });
    pending = [];
    const body = (node as { body?: unknown }).body;
    if (Array.isArray(body)) {
      out.push(...tagsAbove(body as AgencyNode[]));
    }
  }
  if (pending.length > 0) {
    out.push({ node: null, tags: pending });
  }
  return out;
}

/** Every effect declaration in the program, each carrying the tags written
 *  above it as if the preprocessor had already attached them. A copy, so
 *  running this twice never doubles a tag. */
export function effectDeclarationsWithTags(nodes: AgencyNode[]): EffectDeclaration[] {
  return tagsAbove(nodes)
    .filter(
      (entry): entry is { node: EffectDeclaration; tags: Tag[] } =>
        entry.node?.type === "effectDeclaration",
    )
    .map((entry) => ({ ...entry.node, tags: [...(entry.node.tags ?? []), ...entry.tags] }));
}
