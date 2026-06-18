import path from "path";

import type { Input } from "@/eval/runTypes.js";

export function normalizeOptimizeInputs(
  inputs: Input[],
  workingDir: string,
): Input[] {
  return inputs.map((input) => ({
    ...input,
    ...(input.working_dir
      ? { working_dir: path.isAbsolute(input.working_dir) ? input.working_dir : path.resolve(workingDir, input.working_dir) }
      : {}),
  }));
}
