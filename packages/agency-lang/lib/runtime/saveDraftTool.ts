import { z } from "zod";
import type { IntrinsicTool } from "./intrinsicTools.js";

/** The stdlib module id every compiled stdlib export carries. No user
 *  module can carry it, so name+module is identity in practice — the
 *  runtime cannot import the stdlib singleton directly without a
 *  dependency cycle (partials-ergonomics spec Part 2). */
const STDLIB_INDEX_MODULE = "stdlib/index.agency";

/** The contract the type system cannot check, stated to the model. */
const DESCRIPTION =
  "Save your best-so-far answer as a draft. If the budget runs out, the " +
  "last saved draft is returned instead of a failure. The value must " +
  "match this function's return type.";

/** Character count for the acknowledgment message. */
export function draftCharCount(value: unknown): number {
  if (typeof value === "string") return value.length;
  const text = JSON.stringify(value);
  return text === undefined ? 0 : text.length;
}

/** `saveDraft` passed as a tool. Aliases (`const s = saveDraft`) keep
 *  both identity fields, so they recognize; a user's own def named
 *  saveDraft carries its own module id, so it runs as an ordinary
 *  tool. A `.rename()`d stdlib saveDraft changes the name and is NOT
 *  recognized — it falls through to the def path, whose draft files
 *  on the tool branch and is discarded (documented limitation). */
export const saveDraftIntrinsic: IntrinsicTool = {
  matches: (fn) => fn.name === "saveDraft" && fn.module === STDLIB_INDEX_MODULE,

  buildDefinition: ({ draftSchema }) => ({
    name: "saveDraft",
    description: DESCRIPTION,
    schema: z.object({ value: (draftSchema as z.ZodTypeAny) ?? z.string() }),
  }),

  handle: ({ toolCall, stateStack, draftSchema }) => {
    const callArgs = toolCall.arguments ?? {};
    // Own-property check: the args object comes from the model.
    if (!Object.prototype.hasOwnProperty.call(callArgs, "value")) {
      return 'Error: saveDraft requires a "value" argument. Nothing was saved.';
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
