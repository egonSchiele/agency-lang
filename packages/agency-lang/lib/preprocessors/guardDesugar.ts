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
 * Runs inside TypescriptPreprocessor, after parallel desugaring (so
 * guards that parallel moved into fork block arguments are still
 * found) and before anything that lifts or compiles blocks. The walk
 * is bodySlots-driven with one extension: `guardBlock` only occurs as
 * a statement, an assignment value, or a return value (the parser's
 * three registration points), so `value` fields are followed in
 * addition to registered body slots.
 */
export function desugarGuardsInBody(body: AgencyNode[]): AgencyNode[] {
  return body.map(desugarNode);
}

function desugarNode(node: AgencyNode): AgencyNode {
  if (node.type === "guardBlock") {
    return desugarGuardBlock(node as GuardBlock);
  }
  // Explicit annotation: the guardBlock early-return narrows `node`,
  // and an inferred `current` would reject slot.write's full
  // AgencyNode return type.
  let current: AgencyNode = node;
  for (const slot of bodySlots(current)) {
    current = slot.write(current, desugarGuardsInBody(slot.body));
  }
  const value = (current as { value?: unknown }).value;
  if (value && typeof value === "object" && "type" in (value as object)) {
    const rewritten = desugarNode(value as AgencyNode);
    if (rewritten !== value) {
      current = { ...current, value: rewritten } as AgencyNode;
    }
  }
  return current;
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
