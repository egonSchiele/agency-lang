// The public surface users import in a custom grading module:
//   import { grader, ExactMatch, LlmJudge, type Grader } from "agency-lang/optimize";
export { grader, FunctionGrader, toGrader } from "./grading/functionGrader.js";
export type { Grader, GraderFn, GraderContext } from "./grading/functionGrader.js";
export { scalar, binary } from "./grading/grade.js";
export { BaseGrader } from "./grading/baseGrader.js";
export {
  ExactMatchGrader as ExactMatch,
  ContainsGrader as Contains,
  SimilarityGrader as Similarity,
} from "./grading/graders/builtinGraders.js";
export { LlmJudge } from "./grading/graders/llmJudge.js";
export { goalJudgeFile } from "./goalJudgeFile.js";   // for users who want a custom judge but the bundled prompt
export type { Grade, GraderOptions, Input, JSON, JSONPath, Score } from "./grading/types.js";

// The surface users import in a custom optimizer module:
//   import { BaseOptimizer, type BaseOptimizerConfig } from "agency-lang/optimize";
export { BaseOptimizer } from "./baseOptimizer.js";
export type { BaseOptimizerDeps, RunInput, MutationOutcome } from "./baseOptimizer.js";
export type { Optimizer, OptimizerFactory, BaseOptimizerConfig, OptimizeTarget } from "./optimizer.js";
export type { OptimizeResult, MutationProposal } from "./types.js";
export { fileMap } from "./targets.js";
export type { OptimizeTargetSet, OptimizeTarget as OptimizeTargetDecl } from "./targets.js";
export { Scorecard, inputObjective } from "./grading/scorecard.js";
export type { GraderGrade, InputGrades } from "./grading/scorecard.js";
export { proposeMutation } from "./mutator.js";
export type { ProposeMutationArgs } from "./mutator.js";
export { defaultPreview } from "./sourceMutator.js";
export type { OptimizeMutationOperation, OptimizeMutationPreview, OptimizeMutationDiagnostic, OptimizeAppliedChange } from "./sourceMutator.js";
export { renderReflectionFeedback, renderInputFeedback } from "./reflectionFeedback.js";
export { splitInputs } from "./validationSplit.js";
export { breakdown } from "./gradeBreakdown.js";
export type { InputBreakdown, GradeRow } from "./gradeBreakdown.js";
