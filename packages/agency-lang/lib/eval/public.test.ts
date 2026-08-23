import { describe, expect, it } from "vitest";

import * as optimizeApi from "../optimize/public.js";
import * as evalApi from "./public.js";

// Types are erased at runtime, so GRADING_NAMES below cannot guard them; this
// import line IS the guard — typecheck fails if a contract type vanishes.
import type { Grade, GraderOptions, Test, LoadedRun, Score } from "./public.js";
type _TypeExportsAreContract = [Grade, GraderOptions, Test, LoadedRun, Score];

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

/** What statelog imports to summarize uploaded runs and chart batches. */
const TRACKING_NAMES = [
  "summarizeEvalRun",
  "batchStatistics",
  "batchStatisticsByBatch",
  "AnnotationSchema",
  "annotationId",
  "agentNameProblem",
  "AGENT_NAME_PATTERN",
  "AGENT_NAME_MAX_LENGTH",
];

// Type-level contract for the same consumer; erased at runtime, guarded by typecheck.
import type { EvalRunInput, RunSummary, RunStatus, BatchStatistics, Annotation } from "./public.js";
type _TrackingTypesAreContract = [EvalRunInput, RunSummary, RunStatus, BatchStatistics, Annotation];

describe("agency-lang/eval tracking contract", () => {
  it("exports the run summary, batch statistics, annotation schema, and agent-name rule", () => {
    for (const name of TRACKING_NAMES) {
      expect(evalApi, `missing export: ${name}`).toHaveProperty(name);
    }
  });

  it("does not export the run directory internals a consumer could rebuild a snapshot from", () => {
    for (const name of ["readRunDirectory", "readTraces", "tracesFromText", "foldAnnotations"]) {
      expect(evalApi, `leaked internal: ${name}`).not.toHaveProperty(name);
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
