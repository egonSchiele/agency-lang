import { declaredName } from "../types/hole.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * A function cannot be both `destructive` and `idempotent` — the two
 * retry-safety markers are contradictory (one says "dangerous to re-run",
 * the other "always safe to re-run"). The parser accepts both onto the AST
 * (in any order) rather than failing with a generic "unexpected modifier";
 * this pass turns the conflict into a clear diagnostic.
 */
export function checkConflictingMarkers(ctx: TypeCheckerContext): void {
  for (const node of ctx.programNodes) {
    if (
      node.type === "function" &&
      node.markers?.destructive &&
      node.markers?.idempotent
    ) {
      ctx.errors.push(
        diagnostic(
          "conflictingMarkers",
          { name: declaredName(node.functionName) },
          node.loc ?? null,
        ),
      );
    }
  }
}
