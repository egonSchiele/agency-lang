import type { Input } from "@/eval/runTypes.js";

import { makeRng, sampleWithoutReplacement } from "./rng.js";

export type Split = { train: Input[]; validation: Input[] };

/** Hold out a fraction of inputs for validation, deterministically by seed.
 *  Always keeps at least one training input. */
export function splitInputs(inputs: Input[], ratio: number, seed = 0): Split {
  if (!Number.isFinite(ratio)) {
    throw new Error(`--validation-split must be a finite number between 0 and 1, got ${ratio}`);
  }
  const clamped = Math.max(0, Math.min(1, ratio));
  const maxHoldout = Math.max(0, inputs.length - 1);          // always keep ≥1 for training
  const holdout = Math.min(maxHoldout, Math.floor(clamped * inputs.length));
  const validation = sampleWithoutReplacement(inputs, holdout, makeRng(seed));
  const train = inputs.filter((input) => !validation.includes(input));
  return { train, validation };
}
