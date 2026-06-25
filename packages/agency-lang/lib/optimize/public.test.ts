import { describe, expect, it } from "vitest";
import * as api from "./public.js";

describe("public optimize surface", () => {
  it("exports the grader wrapper, base class, and built-in graders", () => {
    expect(typeof api.grader).toBe("function");
    expect(typeof api.BaseGrader).toBe("function");
    expect(typeof api.ExactMatch).toBe("function");
    expect(typeof api.Contains).toBe("function");
    expect(typeof api.Similarity).toBe("function");
    expect(typeof api.LlmJudge).toBe("function");
  });

  it("exports the optimizer-authoring surface", () => {
    expect(typeof api.BaseOptimizer).toBe("function");
    expect(typeof api.fileMap).toBe("function");
    expect(typeof api.proposeMutation).toBe("function");
    expect(typeof api.defaultPreview).toBe("function");
    expect(typeof api.renderReflectionFeedback).toBe("function");
    expect(typeof api.splitInputs).toBe("function");
    expect(typeof api.breakdown).toBe("function");
    expect(typeof api.Scorecard).toBe("function");
  });
});
