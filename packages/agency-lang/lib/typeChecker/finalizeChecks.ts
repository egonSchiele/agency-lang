import type { AgencyNode } from "../types.js";
import type { FinalizeBlock } from "../types/finalizeBlock.js";
import type { ReturnStatement } from "../types/returnStatement.js";
import { walkNodes, type WalkAncestor } from "../utils/node.js";
import { diagnostic } from "./diagnostics.js";
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { InterruptEffect } from "../symbolTable.js";
import { isInScope } from "./checker.js";

/** Ancestor types that make a finalize "nested in control flow" — a
 *  finalize is a declaration, so it may only sit at the top level of a
 *  function body or a trailing `as { }` block body. */
const CONTROL_FLOW_ANCESTORS = [
  "ifElse",
  "forLoop",
  "whileLoop",
  "matchBlock",
  "handleBlock",
  "parallelBlock",
  "seqBlock",
  "withModifier",
  "staticStatement",
  "finalizeBlock",
];

/**
 * The finalize-specific checker rules (the return-TYPE rule needs no code
 * here: finalize bodies are same-scope statements, so the ordinary return
 * checking already reaches them).
 *
 *  - one finalize per container, top level only (AG6032 / AG6033)
 *  - no interrupts, direct or transitive (AG3016)
 *  - no saveDraft inside (AG6034)
 *  - functions and blocks only, not nodes (AG6035)
 *  - in a finalize-bearing container, a return expression containing a
 *    call must BE a single direct call (AG6036) — anything else consumes
 *    an aborted callee inside the expression before the finalize can run.
 */
export function checkFinalizeBlocks(
  scopes: ScopeInfo[],
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): void {
  for (const info of scopes) {
    if (info.name === "top-level") continue;
    const isNode = !!ctx.nodeDefs[info.name];

    // One walk collects finalize blocks and return statements, each keyed
    // by its container: the scope body itself, or the innermost trailing
    // block (`blockArgument` ancestor). Containers are compared by
    // identity — the scope body's key is the ScopeInfo itself.
    const finalizesByContainer: { container: object; node: FinalizeBlock }[] = [];
    const returnsByContainer: { container: object; node: ReturnStatement }[] = [];

    for (const { node, ancestors, scopes: walkScopes } of walkNodes(info.body)) {
      if (!isInScope(walkScopes, info)) continue;
      if (node.type === "finalizeBlock") {
        const nesting = controlFlowAncestor(ancestors);
        if (nesting !== undefined) {
          ctx.errors.push(
            diagnostic("finalizeNotTopLevel", { construct: nesting }, node.loc ?? null),
          );
          continue;
        }
        const container = innermostBlockContainer(ancestors) ?? info;
        if (container === info && isNode) {
          ctx.errors.push(diagnostic("finalizeInNode", {}, node.loc ?? null));
          continue;
        }
        finalizesByContainer.push({ container, node });
        checkFinalizeBody(node, interruptEffectsByFunction, ctx);
      }
      if (node.type === "returnStatement" && !insideFinalize(ancestors)) {
        const container = innermostBlockContainer(ancestors) ?? info;
        returnsByContainer.push({ container, node });
      }
    }

    // Rule: at most one finalize per container.
    const seen: object[] = [];
    for (const { container, node } of finalizesByContainer) {
      if (seen.includes(container)) {
        ctx.errors.push(diagnostic("finalizeDuplicate", {}, node.loc ?? null));
      } else {
        seen.push(container);
      }
    }

    // Rule: return shape, in finalize-bearing containers only.
    for (const { container, node } of returnsByContainer) {
      const hasFinalize = finalizesByContainer.some((f) => f.container === container);
      if (!hasFinalize) continue;
      if (!node.value) continue;
      if (node.value.type === "functionCall") continue; // direct call: interceptable
      if (containsCall(node.value)) {
        ctx.errors.push(diagnostic("finalizeReturnShape", {}, node.loc ?? null));
      }
    }
  }
}

/** The innermost control-flow ancestor BELOW the container boundary, or
 *  undefined when the finalize sits directly in a scope or block body.
 *  Scanning stops at a blockArgument: a finalize at the top of a block is
 *  legal no matter what surrounds the block. */
function controlFlowAncestor(ancestors: WalkAncestor[]): string | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === "blockArgument") return undefined;
    if (CONTROL_FLOW_ANCESTORS.includes(a.type)) return a.type;
  }
  return undefined;
}

/** The innermost trailing-block ancestor, if the node sits inside one. */
function innermostBlockContainer(ancestors: WalkAncestor[]): object | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].type === "blockArgument") return ancestors[i];
  }
  return undefined;
}

function insideFinalize(ancestors: WalkAncestor[]): boolean {
  return ancestors.some((a) => a.type === "finalizeBlock");
}

/** Body rules: no interrupts (direct or via a callee that can interrupt),
 *  no saveDraft. */
function checkFinalizeBody(
  finalize: FinalizeBlock,
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): void {
  for (const { node } of walkNodes(finalize.body)) {
    if (node.type === "interruptStatement") {
      ctx.errors.push(
        diagnostic("finalizeInterrupts", { callee: "interrupt" }, node.loc ?? null),
      );
    }
    if (node.type === "functionCall") {
      if (node.functionName === "saveDraft") {
        ctx.errors.push(diagnostic("finalizeSaveDraft", {}, node.loc ?? null));
        continue;
      }
      const effects = interruptEffectsByFunction[node.functionName];
      if (effects && effects.length > 0) {
        ctx.errors.push(
          diagnostic(
            "finalizeInterrupts",
            { callee: node.functionName },
            node.loc ?? null,
          ),
        );
      }
    }
  }
}

/** True when the expression subtree contains any call — a plain
 *  functionCall, or a value-access chain element that IS a call. The
 *  chain check matters: `arr[0]()` has no functionCall node (the #553
 *  review's soundness hole), only a `kind: "call"` chain element. */
function containsCall(expr: AgencyNode): boolean {
  for (const { node } of walkNodes([expr])) {
    if (node.type === "functionCall") return true;
    if (node.type === "valueAccess") {
      const chain = (node as { chain?: { kind?: string }[] }).chain ?? [];
      if (chain.some((c) => c.kind === "call" || c.kind === "methodCall")) {
        return true;
      }
    }
  }
  return false;
}
