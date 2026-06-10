import type { AgencyConfig } from "@/config.js";
import type { EvalRunTask } from "@/eval/runTypes.js";

export type OptimizeDecision = "baseline" | "accepted" | "rejected" | "validation-failed";
export type OptimizeWinner = "champion" | "candidate" | "tie";

export type MutationProposal = {
  prompt: string;
  rationale: string;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export type OptimizeJudgeSample = {
  winner: OptimizeWinner;
  confidence: number;
  reasoning: string;
};

export type OptimizeTaskVerdict = {
  taskId: string;
  winner: OptimizeWinner;
  confidence: number;
  samples: OptimizeJudgeSample[];
};

export type OptimizeVerdict = {
  iter: number;
  championIter: number | "baseline";
  judgeSamples: number;
  acceptThreshold: number;
  perTask: OptimizeTaskVerdict[];
  wins: number;
  losses: number;
  ties: number;
  margin: number;
  decision: "accepted" | "rejected";
  mutationSummary: string;
  warning?: string;
};

export type IterationResult = {
  iter: number;
  agentPath: string;
  mutationPath?: string;
  evalRunDir?: string;
  verdictPath?: string;
  decision: OptimizeDecision;
  wins: number;
  losses: number;
  ties: number;
};

export type OptimizeResult = {
  runId: string;
  runDir: string;
  championIter: number | "baseline";
  championSource: string;
  acceptedCount: number;
  rejectedCount: number;
  validationFailedCount: number;
  iterations: IterationResult[];
};

export type OptimizeLoopConfig = {
  config: AgencyConfig;
  agentSource: string;
  node: string;
  tasks: EvalRunTask[];
  goal: string;
  iterations: number;
  judgeSamples: number;
  acceptThreshold: number;
  runsDir: string;
  runId: string;
  agentFilename: string;
  workingDir: string;
  mutatorModel?: string;
  writebackPath?: string;
  verbose?: boolean;
};
