import type { AgencyNode, CastExpression } from "../types.js";
import type { BinOpExpression } from "../types/binop.js";
import { PREFIX_OPS, bindsTighterThanCast } from "../types/binop.js";
import { typeRunsValidators } from "../backends/typescriptGenerator/validationDescriptor.js";
import { formatTypeHint } from "../utils/formatType.js";
import { hoistPositions, type HoistStatus } from "../preprocessors/hoistPositions.js";
import { expressionToString } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
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

  // "handlerBody" is left out on purpose: whether a validator may pause
  // there is an open question. AG1016 above still covers handler bodies.
  const castsThatCanPause = (status: HoistStatus): CastExpression[] =>
    positions
      .filter((position) => position.status === status)
      .map((position) => position.node)
      .filter(isCast)
      .filter((cast) => cast.checked && typeRunsValidators(cast.targetType, aliases));

  ctx.errors.push(
    ...misgrouped.map(refusedPositionDiagnostic),
    ...castsThatCanPause("stuck").map(moveToOwnLineDiagnostic),
    ...castsThatCanPause("outsideBodies").map(cannotRunHereDiagnostic),
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

function moveToOwnLineDiagnostic(cast: CastExpression) {
  return diagnostic(
    "castCanPauseInOpaquePosition",
    { cast: expressionToString(cast) },
    cast.loc ?? null,
  );
}

function cannotRunHereDiagnostic(cast: CastExpression) {
  return diagnostic(
    "castCanPauseOutsideBody",
    { cast: expressionToString(cast) },
    cast.loc ?? null,
  );
}
