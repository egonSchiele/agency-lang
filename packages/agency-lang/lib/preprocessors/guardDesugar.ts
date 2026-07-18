import { AgencyNode, Assignment, VariableType } from "@/types.js";
import { FunctionDefinition } from "@/types/function.js";
import { GraphNodeDefinition } from "@/types/graphNode.js";
import { GuardBlock } from "@/types/guardBlock.js";
import { bodySlots, BodySlot } from "@/utils/bodySlots.js";

/**
 * Rewrite every `guardBlock` construct into the legacy
 * `functionCall` + `blockArgument` shape calling the prelude impl
 * `_guard` — the EXACT node shape `guard(...) as { ... }` used to
 * parse to (spec Part 5). After this pass the rest of the compiler
 * cannot tell the construct ever existed: the block goes through the
 * same `__block_N` lifting, the call gets the same frame and step
 * structure, and the runtime is untouched.
 *
 * MUTATES IN PLACE, deliberately. The TypeChecker desugars in its
 * constructor, but the CompilationUnit built beforehand already holds
 * references to the same def/node objects (ctx.functionDefs etc.), and
 * a copying rewrite would leave those references pointing at stale
 * guardBlock bodies — half the pipeline desugared, half not. Mutating
 * the body arrays and value fields in place keeps every capture
 * consistent. Idempotent: a second run finds no guardBlock nodes.
 *
 * The walk is bodySlots-driven with one extension: `guardBlock` only
 * occurs as a statement, an assignment value, or a return value (the
 * parser's three registration points), so `value` fields are followed
 * in addition to registered body slots. The walk threads a context —
 * the current return target (#580) — so annotated guards can stamp
 * their yield type onto the block argument they desugar to.
 */

/** The walk context: the type a `return` statement at this point in
 *  the tree yields to. Captured from the declared return when the
 *  walk enters a def/node body; RESET at every return-retargeting
 *  slot (block arguments, inline handler bodies, finalize bodies —
 *  marked by BodySlot.retargetsReturn) to that slot's own yield: the
 *  stamp a guard block just received, nothing for any other closure.
 *  Absent at top level. */
type DesugarContext = {
  returnTarget?: VariableType;
};

export function desugarGuardsInBody(
  body: AgencyNode[],
  ctx: DesugarContext = {},
): AgencyNode[] {
  body.forEach((node, i) => {
    body[i] = desugarNode(node, ctx);
  });
  return body;
}

/** `successType` of a Result annotation; undefined for anything else.
 *  The desugar never validates — a non-Result annotation simply
 *  stamps nothing, and the checker owns diagnosing it. */
function yieldTypeFrom(
  t: VariableType | null | undefined,
): VariableType | undefined {
  if (t && t.type === "resultType") {
    return t.successType;
  }
  return undefined;
}

/** The context a slot's body walks under: return-retargeting slots
 *  RESET the target to the slot's own yield (a guard block's stamp;
 *  nothing for handlers/finalizes/other blocks — on the second
 *  desugar run the blockAncestor read returns run-1 stamps, which is
 *  when it earns its keep); def/node bodies capture the declared
 *  return; every other body inherits. */
function slotContext(
  node: AgencyNode,
  slot: BodySlot,
  ctx: DesugarContext,
): DesugarContext {
  if (slot.retargetsReturn) {
    return { returnTarget: slot.blockAncestor?.declaredYieldType };
  }
  if (node.type === "function" || node.type === "graphNode") {
    const def = node as FunctionDefinition | GraphNodeDefinition;
    return { returnTarget: def.returnType ?? undefined };
  }
  return ctx;
}

/** The type a guard sitting in this node's `value` slot is stamped
 *  with: an assignment names its own slot; a return yields to the
 *  current return target; anything else stamps nothing. */
function stampFor(
  node: AgencyNode,
  ctx: DesugarContext,
): VariableType | undefined {
  if (node.type === "assignment") {
    return yieldTypeFrom((node as Assignment).typeHint);
  }
  if (node.type === "returnStatement") {
    return yieldTypeFrom(ctx.returnTarget);
  }
  return undefined;
}

function desugarNode(node: AgencyNode, ctx: DesugarContext): AgencyNode {
  if (node.type === "guardBlock") {
    // Statement position: nothing to yield to, no stamp.
    return desugarGuardBlock(node as GuardBlock, undefined);
  }
  // slot.body is the node's actual array; recursing mutates it in
  // place, so no slot.write copies are made.
  for (const slot of bodySlots(node)) {
    desugarGuardsInBody(slot.body, slotContext(node, slot, ctx));
  }
  const holder = node as { value?: unknown };
  const value = holder.value;
  if (!value || typeof value !== "object" || !("type" in (value as object))) {
    return node;
  }
  const valueNode = value as AgencyNode;
  if (valueNode.type === "guardBlock") {
    holder.value = desugarGuardBlock(
      valueNode as GuardBlock,
      stampFor(node, ctx),
    );
    return node;
  }
  const rewritten = desugarNode(valueNode, ctx);
  if (rewritten !== valueNode) {
    holder.value = rewritten;
  }
  return node;
}

function desugarGuardBlock(
  g: GuardBlock,
  yieldType: VariableType | undefined,
): AgencyNode {
  // The head arguments forward VERBATIM. Named, positional, unknown,
  // duplicated — all of it lands on the `_guard` call and gets exactly
  // the validation and diagnostics the legacy call syntax got from the
  // same signature. The desugar validates nothing.
  //
  // The stamp, when present, becomes the return target for the block's
  // own body — which is how nested return-position guards compose.
  // declaredYieldType is always assigned: absent and undefined are
  // equivalent for every consumer, and JSON.stringify drops undefined
  // keys, so AST output for unstamped guards is unchanged.
  return {
    type: "functionCall",
    functionName: "_guard",
    arguments: g.arguments,
    block: {
      type: "blockArgument",
      inline: false,
      params: [],
      declaredYieldType: yieldType,
      body: desugarGuardsInBody(g.body, { returnTarget: yieldType }),
    },
    // The prelude import is what resolves `_guard`, so the call's
    // symbol scope matches what the legacy imported call carried.
    scope: "imported",
    loc: g.loc,
  } as unknown as AgencyNode;
}
