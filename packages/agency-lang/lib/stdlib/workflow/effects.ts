/**
 * What each tool step of a workflow can raise. The `raises` check, the
 * `agency workflow check` listing, and `agency workflow run`'s approval
 * prompt all read this one list.
 */
import { signatureKey, type Signature, type ToolStep, type Workflow } from "./types.js";

/** One tool step and the effects its tool can raise. */
export type StepEffects = { step: string; tool: string; effects: string[] };

/** The generated program rejects every guard trip itself (render.ts), so a
 *  trip never reaches whoever runs the workflow. */
const ANSWERED_BY_THE_PROGRAM = "std::guard";

/** The effects each tool step raises, in step order. `std::guard` is left
 *  out: the generated program rejects every guard trip itself, so it never
 *  reaches a caller. A step whose signature is missing raises nothing here;
 *  resolve reports that step on its own. */
export function stepEffects(
  workflow: Workflow,
  signatures: Record<string, Signature>,
): StepEffects[] {
  return workflow.steps
    .filter((step): step is ToolStep => step.kind === "tool")
    .map((step) => {
      const signature = signatures[signatureKey(step.module, step.tool)];
      const effects = signature === undefined ? [] : signature.effects;
      return {
        step: step.id,
        tool: step.tool,
        effects: effects.filter((effect) => effect !== ANSWERED_BY_THE_PROGRAM),
      };
    });
}
