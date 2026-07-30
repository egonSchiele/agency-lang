import { describe, expect, it } from "vitest";

import * as optimizeApi from "../optimize/public.js";
import * as evalApi from "./public.js";

// Types are erased at runtime, so GRADING_NAMES below cannot guard them; this
// import line IS the guard — typecheck fails if a contract type vanishes.
import type { Grade, GraderOptions, Input, LoadedRun, Score } from "./public.js";
type _TypeExportsAreContract = [Grade, GraderOptions, Input, LoadedRun, Score];

/** The grader-authoring names. Both entry points must expose all of them:
 *  `agency-lang/eval` as the new home, `agency-lang/optimize` by re-export so
 *  existing grading modules keep working without an edit. */
const GRADING_NAMES = [
  "grader",
  "toGrader",
  "FunctionGrader",
  "BaseGrader",
  "scalar",
  "binary",
  "ExactMatch",
  "Contains",
  "Similarity",
  "LlmJudge",
  "goalJudgeFile",
  "Scorecard",
  "inputObjective",
  "breakdown",
];

describe("agency-lang/eval public surface", () => {
  it("exports the grader authoring API", () => {
    for (const name of GRADING_NAMES) {
      expect(evalApi, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});

describe("agency-lang/optimize public surface", () => {
  it("still exports every grading name, so existing modules keep working", () => {
    for (const name of GRADING_NAMES) {
      expect(optimizeApi, `missing re-export: ${name}`).toHaveProperty(name);
    }
  });

  it("keeps its optimizer-only exports", () => {
    for (const name of [
      "BaseOptimizer",
      "fileMap",
      "proposeMutation",
      "defaultPreview",
      "renderReflectionFeedback",
      "renderInputFeedback",
      "splitInputs",
    ]) {
      expect(optimizeApi, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});
