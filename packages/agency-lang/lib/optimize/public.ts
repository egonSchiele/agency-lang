// Grading lives in the eval layer now. Re-exported here so existing grading
// modules that import from "agency-lang/optimize" keep working with no edit.
// New modules should prefer "agency-lang/eval".
export {
  grader,
  FunctionGrader,
  toGrader,
  scalar,
  binary,
  BaseGrader,
  ExactMatch,
  Contains,
  Similarity,
  LlmJudge,
  goalJudgeFile,
  Scorecard,
  inputObjective,
  breakdown,
} from "@/eval/public.js";
export type {
  Grader,
  GraderFn,
  GraderContext,
  LoadedRun,
  Grade,
  GraderOptions,
  Test,
  JSON,
  JSONPath,
  Score,
  GraderGrade,
  InputGrades,
  InputBreakdown,
  GradeRow,
} from "@/eval/public.js";

// The surface users import in a custom optimizer module:
//   import { BaseOptimizer, type BaseOptimizerConfig } from "agency-lang/optimize";
export { BaseOptimizer } from "./baseOptimizer.js";
export type { BaseOptimizerDeps, RunInput, MutationOutcome } from "./baseOptimizer.js";
export type {
  Optimizer,
  OptimizerFactory,
  BaseOptimizerConfig,
  OptimizeTarget,
} from "./optimizer.js";
export type { OptimizeResult, MutationProposal } from "./types.js";
export { fileMap } from "./targets.js";
export type { OptimizeTargetSet, OptimizeTarget as OptimizeTargetDecl } from "./targets.js";
export { proposeMutation } from "./mutator.js";
export type { ProposeMutationArgs } from "./mutator.js";
export { defaultPreview } from "./sourceMutator.js";
export type {
  OptimizeMutationOperation,
  OptimizeMutationPreview,
  OptimizeMutationDiagnostic,
  OptimizeAppliedChange,
} from "./sourceMutator.js";
export { renderReflectionFeedback, renderInputFeedback } from "./reflectionFeedback.js";
export { splitInputs } from "./validationSplit.js";
