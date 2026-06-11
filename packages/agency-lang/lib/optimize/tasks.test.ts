import { describe, expect, it } from "vitest";

import { normalizeOptimizeTasks } from "./tasks.js";

describe("normalizeOptimizeTasks", () => {
  it("resolves relative working_dir values against the optimizer workingDir", () => {
    const tasks = normalizeOptimizeTasks(
      [{ task_id: "t1", rubric: "r", args: {}, working_dir: "fixtures" }],
      "/repo/project",
    );

    expect(tasks[0].working_dir).toBe("/repo/project/fixtures");
  });

  it("preserves absolute working_dir values", () => {
    const tasks = normalizeOptimizeTasks(
      [{ task_id: "t1", rubric: "r", args: {}, working_dir: "/tmp/fixtures" }],
      "/repo/project",
    );

    expect(tasks[0].working_dir).toBe("/tmp/fixtures");
  });

  it("does not mutate input tasks", () => {
    const input = [{ task_id: "t1", rubric: "r", args: {}, working_dir: "fixtures" }];
    normalizeOptimizeTasks(input, "/repo/project");
    expect(input[0].working_dir).toBe("fixtures");
  });
});
