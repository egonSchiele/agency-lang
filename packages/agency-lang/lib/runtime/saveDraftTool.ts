import { z } from "zod";
import type { IntrinsicTool } from "./intrinsicTools.js";

/** The stdlib module id every compiled stdlib export carries. No user
 *  module can carry it, so name+module is identity in practice — the
 *  runtime cannot import the stdlib singleton directly without a
 *  dependency cycle (partials-ergonomics spec Part 2). */
const STDLIB_INDEX_MODULE = "stdlib/index.agency";

/** What the model reads. Says WHEN to call (each time the answer
 *  improves), the replacement semantics (last save wins), WHY it is
 *  worth calling (early stop returns the draft, not a failure), and
 *  the one mistake to head off: saving a note or a delta instead of
 *  the complete answer. The value's SHAPE is communicated by the tool
 *  schema, so the prose does not restate it. */
const DESCRIPTION =
  "Save your best-so-far answer as a draft. Call it again whenever " +
  "your answer improves: each call replaces the previous draft, and " +
  "the last one wins. If the run is stopped early by a cost or time " +
  "budget, the last saved draft is returned instead of a failure, so " +
  "save whenever you complete a meaningful piece of work. Always pass " +
  "the complete answer as it stands, not a note or a diff.";

/** Character count for the acknowledgment message. Never throws: the
 *  value normally comes from model tool args (JSON, so circular refs
 *  and BigInt are unreachable), but this is an exported helper, so it
 *  honors the claim for arbitrary inputs too. */
export function draftCharCount(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : text.length;
  } catch {
    return 0;
  }
}

/** `saveDraft` passed as a tool. Recognition is by `registeredName`
 *  (the registry key `.rename()` preserves, #653) plus the stdlib
 *  module id: aliases (`const s = saveDraft`), `.rename()`d copies,
 *  and derived forms all recognize, while a user's own def named
 *  saveDraft carries its own module id and runs as an ordinary tool.
 *  The synthesized definition advertises `fn.name` — the renamed name
 *  when there is one — because that is what the model calls and what
 *  tool-call dispatch matches against (#654). */
export const saveDraftIntrinsic: IntrinsicTool = {
  matches: (fn) =>
    fn.registeredName === "saveDraft" && fn.module === STDLIB_INDEX_MODULE,

  buildDefinition: ({ draftSchema, fn }) => ({
    name: fn.name,
    description: DESCRIPTION,
    schema: z.object({ value: (draftSchema as z.ZodTypeAny) ?? z.string() }),
  }),

  handle: ({ toolCall, stateStack, draftSchema }) => {
    const callArgs = toolCall.arguments ?? {};
    // Own-property check: the args object comes from the model.
    if (!Object.prototype.hasOwnProperty.call(callArgs, "value")) {
      return `Error: ${toolCall.name} requires a "value" argument. Nothing was saved.`;
    }
    const value = callArgs.value;
    // Save FIRST, validate second. The schema is a best-effort hint
    // keyed to the declared function type, and the actual slot (often
    // a guard block) can legitimately differ — refusing the save on a
    // possibly-wrong hint would throw away real work. The warning
    // teaches the model without costing it the draft.
    stateStack.setSavedDraft(value);
    const saved = `Draft saved (${draftCharCount(value)} characters).`;
    const valueSchema = (draftSchema as z.ZodTypeAny) ?? z.string();
    const parsed = valueSchema.safeParse(value);
    if (parsed.success) return saved;
    const issue = parsed.error.issues[0];
    return (
      `${saved} Warning: the value does not match this function's ` +
      `declared return type (${issue?.message ?? "type mismatch"}). ` +
      `The draft was kept, but match the declared type on your next save.`
    );
  },
};
