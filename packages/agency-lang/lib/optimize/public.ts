// The public surface users import in a custom grading module:
//   import { grader, ExactMatch, LlmJudge, type Grader } from "agency-lang/optimize";
export { grader, FunctionGrader, toGrader } from "./grading/functionGrader.js";
export type { Grader, GraderFn, GraderContext } from "./grading/functionGrader.js";
export { BaseGrader } from "./grading/baseGrader.js";
export {
  ExactMatchGrader as ExactMatch,
  ContainsGrader as Contains,
  SimilarityGrader as Similarity,
} from "./grading/graders/builtinGraders.js";
export { LlmJudge } from "./grading/graders/llmJudge.js";
export { goalJudgeFile } from "./goalJudgeFile.js";   // for users who want a custom judge but the bundled prompt
export type { Grade, GraderOptions, Input, JSON, JSONPath, Score } from "./grading/types.js";
