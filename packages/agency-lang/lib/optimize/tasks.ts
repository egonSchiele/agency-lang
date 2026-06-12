import path from "path";

import type { EvalTask } from "@/eval/runTypes.js";

export function normalizeOptimizeTasks(
  tasks: EvalTask[],
  workingDir: string,
): EvalTask[] {
  return tasks.map((task) => ({
    ...task,
    ...(task.working_dir
      ? { working_dir: path.isAbsolute(task.working_dir) ? task.working_dir : path.resolve(workingDir, task.working_dir) }
      : {}),
  }));
}
