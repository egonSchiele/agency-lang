import type { AgencyNode, ValueAccess } from "../types.js";
import { hasUnwrap, isUnwrapElement } from "../types/access.js";
import { hoistPositions } from "../preprocessors/hoistPositions.js";
import { expressionToString, isInsideBlock, walkNodes, type WalkAncestor } from "../utils/node.js";
import { formatTypeHint } from "../utils/formatType.js";
import { isAssignable } from "./assignability.js";
import { diagnostic } from "./diagnostics.js";
import { positionRefusals } from "./positionRefusals.js";
import { ANY_T } from "./primitives.js";
import type { ScopeInfo, TypeCheckError, TypeCheckerContext } from "./types.js";

/** The refusals that stand between a `?` and the codegen tripwire. The
 *  compile path treats them as fatal whether or not the type checker is in
 *  strict mode, the way it treats the platform diagnostic, because a
 *  warning here would let compilation run on into the throw. */
const CODEGEN_GUARD_REFUSALS: string[] = [
  "unwrapInOpaquePosition",
  "unwrapOutsideBody",
  "unwrapInHandlerBody",
  "unwrapInParallelArm",
  "unwrapInAssignmentTarget",
];

export function isUnwrapRefusal(error: TypeCheckError): boolean {
  return CODEGEN_GUARD_REFUSALS.includes(error.name);
}

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

/** Every `?` under `nodes`, with the ancestors it was found under. */
function unwrapAccesses(nodes: AgencyNode[]): { access: ValueAccess; ancestors: WalkAncestor[] }[] {
  return [...walkNodes(nodes)]
    .filter(({ node }) => isUnwrapAccess(node))
    .map(({ node, ancestors }) => ({ access: node as ValueAccess, ancestors }));
}

function returnTypeRefusals(info: ScopeInfo, ctx: TypeCheckerContext) {
  const declared = info.returnType;
  if (!declared || isAssignable(RESULT_OF_ANY, declared, ctx.getTypeAliases())) {
    return [];
  }
  // A `return` inside a block argument belongs to the block, and so does the
  // return a `?` lowers to.
  return unwrapAccesses(info.body)
    .filter(({ ancestors }) => !isInsideBlock(ancestors))
    .map(({ access }) =>
      diagnostic(
        "unwrapReturnTypeNotResult",
        { expr: operandText(access), name: info.name, type: formatTypeHint(declared) },
        access.loc ?? null,
      ),
    );
}

/** True when the nearest `parallel` ancestor is reached with no block
 *  argument in between, which makes the node part of an arm's own statements. */
function atTopLevelOfArm(ancestors: WalkAncestor[]): boolean {
  const armIndex = ancestors.map((a) => a.type).lastIndexOf("parallelBlock");
  if (armIndex === -1) return false;
  return !ancestors.slice(armIndex + 1).some((a) => a.type === "blockArgument");
}

function parallelArmRefusals(nodes: AgencyNode[]) {
  return unwrapAccesses(nodes)
    .filter(({ ancestors }) => atTopLevelOfArm(ancestors))
    .map(({ access }) =>
      diagnostic("unwrapInParallelArm", { expr: operandText(access) }, access.loc ?? null),
    );
}

/** The target of `obj?.field = 1`, as the access it would read. */
function assignmentTarget(node: AgencyNode & { type: "assignment" }): ValueAccess {
  return {
    type: "valueAccess",
    base: { type: "variableName", value: node.variableName },
    chain: node.accessChain ?? [],
  } as unknown as ValueAccess;
}

function assignmentTargetRefusals(nodes: AgencyNode[]) {
  return [...walkNodes(nodes)]
    .map(({ node }) => node)
    .filter(
      (node): node is AgencyNode & { type: "assignment" } =>
        node.type === "assignment" && (node.accessChain ?? []).some(isUnwrapElement),
    )
    .map((node) =>
      diagnostic(
        "unwrapInAssignmentTarget",
        { expr: operandText(assignmentTarget(node)) },
        node.loc ?? null,
      ),
    );
}
