import { AgencyNode } from "@/types.js";
import { GuardBlock } from "@/types/guardBlock.js";
import { bodySlots } from "@/utils/bodySlots.js";

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
 * in addition to registered body slots.
 */
export function desugarGuardsInBody(body: AgencyNode[]): AgencyNode[] {
  body.forEach((node, i) => {
    body[i] = desugarNode(node);
  });
  return body;
}

function desugarNode(node: AgencyNode): AgencyNode {
  if (node.type === "guardBlock") {
    return desugarGuardBlock(node as GuardBlock);
  }
  // slot.body is the node's actual array; recursing mutates it in
  // place, so no slot.write copies are made.
  for (const slot of bodySlots(node)) {
    desugarGuardsInBody(slot.body);
  }
  const holder = node as { value?: unknown };
  const value = holder.value;
  if (value && typeof value === "object" && "type" in (value as object)) {
    const rewritten = desugarNode(value as AgencyNode);
    if (rewritten !== value) {
      holder.value = rewritten;
    }
  }
  return node;
}

function desugarGuardBlock(g: GuardBlock): AgencyNode {
  const fields = { cost: g.cost, time: g.time, label: g.label };
  // Absent args are OMITTED from the call — the impl's defaults supply
  // null, exactly as when users wrote the call themselves.
  const args = g.argOrder
    .filter((name) => fields[name] !== null)
    .map((name) => ({
      type: "namedArgument" as const,
      name,
      value: fields[name]!,
    }));
  return {
    type: "functionCall",
    functionName: "_guard",
    arguments: args,
    block: {
      type: "blockArgument",
      inline: false,
      params: [],
      body: desugarGuardsInBody(g.body),
    },
    // The prelude import is what resolves `_guard`, so the call's
    // symbol scope matches what the legacy imported call carried.
    scope: "imported",
    loc: g.loc,
  } as unknown as AgencyNode;
}
