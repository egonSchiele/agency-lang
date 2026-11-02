import type { AgencyNode, ValueAccess } from "../types.js";
import { hasUnwrap, isUnwrapElement } from "../types/access.js";
import { hoistPositions } from "../preprocessors/hoistPositions.js";
import { expressionToString, isInsideBlock, walkNodes, type WalkAncestor } from "../utils/node.js";
import { formatTypeHint } from "../utils/formatType.js";
import { isAssignable } from "./assignability.js";
import { diagnostic } from "./diagnostics.js";
import { positionRefusals } from "./positionRefusals.js";
import { ANY_T } from "./primitives.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";

const isUnwrapAccess = (node: AgencyNode): node is ValueAccess =>
  node.type === "valueAccess" && hasUnwrap(node);

/** The access printed without its trailing `?`, so a message can say `{expr}?`. */
function operandText(access: ValueAccess): string {
  const last = access.chain[access.chain.length - 1];
  const chain = last && isUnwrapElement(last) ? access.chain.slice(0, -1) : access.chain;
  return expressionToString({ ...access, chain });
}

const RESULT_OF_ANY = { type: "resultType" as const, successType: ANY_T, dataType: ANY_T };

/**
 * The `?` operator is refused where it cannot do what it says. It is lowered
 * to an early return by the hoist pass, so it is refused where that pass
 * cannot lift from (AG1021 to AG1023, the same statuses a pausing cast is
 * refused in), in a function whose declared return type cannot hold a
 * failure (AG2024), at the top level of a `parallel` arm, which cannot return
 * early (AG1024), and in a write target (AG1025).
 */
export function checkUnwraps(scopes: ScopeInfo[], ctx: TypeCheckerContext): void {
  const positions = hoistPositions(ctx.programNodes);
  ctx.errors.push(
    ...positionRefusals(
      positions,
      isUnwrapAccess,
      {
        stuck: "unwrapInOpaquePosition",
        outsideBodies: "unwrapOutsideBody",
        handlerBody: "unwrapInHandlerBody",
      },
      (access) => ({ expr: operandText(access) }),
    ),
    ...scopes.flatMap((scope) => returnTypeRefusals(scope, ctx)),
    ...parallelArmRefusals(ctx.programNodes),
    ...assignmentTargetRefusals(ctx.programNodes),
  );
}

function returnTypeRefusals(info: ScopeInfo, ctx: TypeCheckerContext) {
  const declared = info.returnType;
  if (!declared || isAssignable(RESULT_OF_ANY, declared, ctx.getTypeAliases())) {
    return [];
  }
  const found: ValueAccess[] = [];
  for (const { node, ancestors } of walkNodes(info.body)) {
    // A `return` inside a block argument belongs to the block, and so does
    // the return a `?` lowers to.
    if (isUnwrapAccess(node) && !isInsideBlock(ancestors)) {
      found.push(node);
    }
  }
  return found.map((access) =>
    diagnostic(
      "unwrapReturnTypeNotResult",
      { expr: operandText(access), name: info.name, type: formatTypeHint(declared) },
      access.loc ?? null,
    ),
  );
}

/** True when the nearest `parallel` ancestor is reached with no block
 *  argument in between, which makes `node` part of an arm's own statements. */
function atTopLevelOfArm(ancestors: WalkAncestor[]): boolean {
  const armIndex = ancestors.map((a) => a.type).lastIndexOf("parallelBlock");
  if (armIndex === -1) return false;
  return !ancestors.slice(armIndex + 1).some((a) => a.type === "blockArgument");
}

function parallelArmRefusals(nodes: AgencyNode[]) {
  const found: ValueAccess[] = [];
  for (const { node, ancestors } of walkNodes(nodes)) {
    if (isUnwrapAccess(node) && atTopLevelOfArm(ancestors)) {
      found.push(node);
    }
  }
  return found.map((access) =>
    diagnostic("unwrapInParallelArm", { expr: operandText(access) }, access.loc ?? null),
  );
}

function assignmentTargetRefusals(nodes: AgencyNode[]) {
  const errors = [];
  for (const { node } of walkNodes(nodes)) {
    if (node.type !== "assignment" || !node.accessChain?.some(isUnwrapElement)) continue;
    const target = {
      type: "valueAccess" as const,
      base: { type: "variableName" as const, value: node.variableName },
      chain: node.accessChain,
    };
    errors.push(
      diagnostic(
        "unwrapInAssignmentTarget",
        { expr: operandText(target as unknown as ValueAccess) },
        node.loc ?? null,
      ),
    );
  }
  return errors;
}
