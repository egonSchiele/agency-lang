/**
 * What each tool step of a workflow can raise. The `raises` check, the
 * `agency workflow check` listing, and `agency workflow run`'s approval
 * prompt all read this one list.
 */
import { signatureKey, type Signature, type ToolStep, type Workflow } from "./types.js";

/** One tool step and the effects its tool can raise. */
export type StepEffects = { step: string; tool: string; effects: string[] };

/** A guard trip asks for more budget, not for a permission. The program
 *  rejects its own guards' trips (render.ts), and a tool's own guard is the
 *  tool's to answer. Neither belongs in `raises` or the run's prompt. */
const BUDGET_EFFECT = "std::guard";

/** The effects each tool step raises, in step order. `std::guard` is left
 *  out, since it is a question about budget, not a permission. A step whose signature is missing raises nothing here;
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
        effects: effects.filter((effect) => effect !== BUDGET_EFFECT),
      };
    });
}
