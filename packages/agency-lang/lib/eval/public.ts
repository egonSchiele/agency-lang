// The public surface users import when writing graders:
//   import { grader, ExactMatch, LlmJudge, type Grader } from "agency-lang/eval";
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
export { goalJudgeFile } from "./grading/goalJudgeFile.js"; // for users who want a custom judge but the bundled prompt
export type {
  LoadedRun,
  Grade,
  GraderOptions,
  Test,
  JSON,
  JSONPath,
  Score,
} from "./grading/types.js";
export { Scorecard, inputObjective } from "./grading/scorecard.js";
export type { GraderGrade, InputGrades } from "./grading/scorecard.js";
export { breakdown } from "./grading/gradeBreakdown.js";
export type { InputBreakdown, GradeRow } from "./grading/gradeBreakdown.js";
