import { describe, expect, it } from "vitest";

import { normalizeOptimizeInputs } from "./inputs.js";

describe("normalizeOptimizeInputs", () => {
  it("resolves relative working_dir values against the optimizer workingDir", () => {
    const inputs = normalizeOptimizeInputs(
      [{ id: "t1", goal: "g", args: {}, working_dir: "fixtures" }],
      "/repo/project",
    );

    expect(inputs[0].working_dir).toBe("/repo/project/fixtures");
  });

  it("preserves absolute working_dir values", () => {
    const inputs = normalizeOptimizeInputs(
      [{ id: "t1", goal: "g", args: {}, working_dir: "/tmp/fixtures" }],
      "/repo/project",
    );

    expect(inputs[0].working_dir).toBe("/tmp/fixtures");
  });

  it("does not mutate input objects", () => {
    const input = [{ id: "t1", goal: "g", args: {}, working_dir: "fixtures" }];
    normalizeOptimizeInputs(input, "/repo/project");
    expect(input[0].working_dir).toBe("fixtures");
  });
});
