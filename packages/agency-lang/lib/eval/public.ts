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
export { AgencyTestGrader } from "./grading/agencyTestGrader.js";
export { goalJudgeFile } from "./grading/goalJudgeFile.js"; // for users who want a custom judge but the bundled prompt
export type {
  LoadedRun,
  GraderInput,
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

// The eval tracking contract statelog imports (`agency-lang/eval`): summarize
// one run from its canonical rows, compute batch statistics over summaries,
// validate annotation rows and agent names. Deliberately narrow: no run
// directory reader, trace parser, or annotation fold is exported, so a
// consumer cannot rebuild agency-lang's internal snapshot and derive a second
// definition of score, status, cost, or timestamps.
export { summarizeEvalRun } from "../runDirectory/list.js";
export type { EvalRunInput, RunSummary, RunStatus } from "../runDirectory/list.js";
export { batchStatistics, batchStatisticsByBatch } from "./batchStatistics.js";
export type { BatchStatistics, TestStatistics } from "./batchStatistics.js";
export { AnnotationSchema, annotationId } from "../runDirectory/annotations.js";
export type {
  Annotation,
  AnnotationDraft,
  AnnotationPayload,
  RunPayload,
  ScorePayload,
  ChecklistPayload,
} from "../runDirectory/annotations.js";
export type { EventEnvelope } from "../statelog/wireTypes.js";
export {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_PATTERN,
  agentNameProblem,
} from "../statelog/agentName.js";
