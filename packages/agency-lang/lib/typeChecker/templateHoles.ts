import { AgencyNode, Hole } from "../types.js";
import { walkNodesArray } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";

/**
 * Template-only checks. Two rules:
 *
 * AG8002 — an expression hole must get a type from somewhere: its position
 * (`const x: string = #text`) or an inline annotation (`#text: string`).
 * A hole with neither is unconstrained, which defeats fill-time checking.
 * v1 recognizes the assignment position; other untyped positions default
 * to `any` in the synthesizer and are not flagged.
 *
 * Name resolution after a hole needs no code here, deliberately: the
 * checker cannot see what a hole will introduce, so template code that
 * references a filler-introduced name fails the ordinary undefined-
 * variable check at template-check time. That IS the "bindings are local
 * to the hole" rule; the test pins it.
 */
export function checkTemplateHoles(ctx: TypeCheckerContext): void {
  for (const visit of walkNodesArray(ctx.programNodes)) {
    if (visit.node.type !== "hole") continue;
    const hole = visit.node as Hole;
    if (hole.sort !== "expr" || hole.typeAnnotation) continue;
    const parent = visit.ancestors[visit.ancestors.length - 1] as
      | AgencyNode
      | undefined;
    if (parent && parent.type === "assignment" && !parent.typeHint) {
      ctx.errors.push(
        diagnostic("holeNeedsTypeAnnotation", { name: hole.name }, hole.loc ?? null),
      );
    }
  }
}
