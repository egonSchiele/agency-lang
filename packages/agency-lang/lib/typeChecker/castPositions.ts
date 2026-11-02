import type { AgencyNode, CastExpression } from "../types.js";
import type { BinOpExpression } from "../types/binop.js";
import { PREFIX_OPS, bindsTighterThanCast } from "../types/binop.js";
import { typeRunsValidators } from "../backends/typescriptGenerator/validationDescriptor.js";
import { formatTypeHint } from "../utils/formatType.js";
import { hoistPositions } from "../preprocessors/hoistPositions.js";
import { expressionToString } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import { positionRefusals } from "./positionRefusals.js";
import type { TypeCheckerContext } from "./types.js";

const isBinOp = (node: AgencyNode): node is BinOpExpression => node.type === "binOpExpression";
const isCast = (node: AgencyNode): node is CastExpression => node.type === "castExpression";

/** `a + b as T`: Agency would group it as `a + (b as T)`, TypeScript as
 *  `(a + b) as T`. Prefix operators take a finished atom, so they agree. */
function hasMisgroupedCast(node: BinOpExpression): boolean {
  const right = node.right;
  const isBareCast = right.type === "castExpression" && !right.parenthesized;
  return isBareCast && !PREFIX_OPS.includes(node.operator) && bindsTighterThanCast(node.operator);
}

export function checkCastPositions(ctx: TypeCheckerContext): void {
  const positions = hoistPositions(ctx.programNodes);
  const aliases = ctx.getTypeAliases();

  const misgrouped = positions
    .map((position) => position.node)
    .filter(isBinOp)
    .filter(hasMisgroupedCast);

  const isCastThatCanPause = (node: AgencyNode): node is CastExpression =>
    isCast(node) && node.checked && typeRunsValidators(node.targetType, aliases);

  // A handler body never pauses and the pass never rewrites one, so moving
  // the cast to its own line inside the handler would not help; AG1020 says
  // to do the cast before the `handle` block. The broader question of what
  // any pausing Agency call does in a handler body stays open; a cast is
  // refused because a `@validate` tag on a type declared elsewhere hides the
  // interrupt that a call shows in the source.
  ctx.errors.push(
    ...misgrouped.map(refusedPositionDiagnostic),
    ...positionRefusals(
      positions,
      isCastThatCanPause,
      {
        stuck: "castCanPauseInOpaquePosition",
        outsideBodies: "castCanPauseOutsideBody",
        handlerBody: "castCanPauseInHandlerBody",
      },
      (cast) => ({ cast: expressionToString(cast) }),
    ),
  );
}

function refusedPositionDiagnostic(node: BinOpExpression) {
  const cast = node.right as CastExpression;
  const params = {
    left: expressionToString(node.left),
    op: node.operator,
    right: expressionToString(cast.expression),
    type: formatTypeHint(cast.targetType),
  };
  return diagnostic("castRefusedPosition", params, cast.loc ?? node.loc ?? null);
}
