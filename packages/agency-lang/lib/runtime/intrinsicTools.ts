import type { AgencyFunction, ToolDefinition } from "./agencyFunction.js";
import type { StateStack } from "./state/stateStack.js";
import { saveDraftIntrinsic } from "./saveDraftTool.js";

/** What one intrinsic call sees. Deliberately narrow: an intrinsic
 *  manipulates the RUN (frames, drafts), not the outside world, so it
 *  gets the call, the stack, and the threaded schema — nothing else.
 *  Widen this type only when a new intrinsic genuinely needs more. */
export type IntrinsicCall = {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  stateStack: StateStack;
  /** Zod schema threaded by the llm() codegen (saveDraft's value
   *  type); undefined when the call site had none. */
  draftSchema: unknown;
};

/** A tool the tool loop handles ITSELF, inline in the ordered pass,
 *  instead of dispatching into the concurrent pool. The loop owns all
 *  the generic bookkeeping — resume idempotency, statelog events,
 *  callbacks, the tool-result message — so `handle` is just the
 *  semantics and must be fast, synchronous, and interrupt-free.
 *  The registry is CLOSED: intrinsics touch run state, which is
 *  exactly what user tools must never do, so additions are code
 *  changes here, not a user-facing extension point. */
export type IntrinsicTool = {
  /** Identity check against a tools-array entry (name+module pair,
   *  never object identity — the prelude auto-import means modules
   *  hold their own wrapper objects). */
  matches: (fn: AgencyFunction) => boolean;
  /** The provider-facing definition, replacing the def's own. */
  buildDefinition: (ctx: { draftSchema: unknown }) => ToolDefinition;
  /** Handle one call; the return value is the tool-result text. */
  handle: (call: IntrinsicCall) => string;
};

const INTRINSIC_TOOLS: IntrinsicTool[] = [saveDraftIntrinsic];

export function findIntrinsic(fn: AgencyFunction): IntrinsicTool | undefined {
  return INTRINSIC_TOOLS.find((t) => t.matches(fn));
}
