export type JudgeWinner = "A" | "B" | "tie";

export type PairwiseJudgeResult = {
  winner: JudgeWinner;
  confidence: number;
  reasoning: string;
};

export type PairwiseVerdict = {
  verdictVersion: 1;
  goal: string;
  inputs: [
    { path: string; response: string | null; truncated?: true },
    { path: string; response: string | null; truncated?: true },
  ];
  winner: JudgeWinner;
  confidence: number;
  reasoning: string;
  generatedAt: string;
};

export type JudgeAggregationPolicy = {
  samples: number;
  confidenceThreshold: number;
  marginThreshold: number;
  positionBias: "swap" | "none";
};

export type JudgeSample = {
  winner: JudgeWinner;
  confidence: number;
  reasoning: string;
  order: "AB" | "BA";
};

export type TaskVerdictInput = {
  path?: string;
  status: "ok" | "missing" | "failed";
  response?: string | null;
  truncated?: true;
  errorMessage?: string;
};

export type TaskVerdict = {
  taskId: string;
  goal: string;
  inputs: [TaskVerdictInput, TaskVerdictInput];
  winner: JudgeWinner;
  confidence: number;
  reasoning: string;
  samples: JudgeSample[];
  generatedAt: string;
};

export type SuiteVerdict = {
  verdictVersion: 2;
  generatedAt: string;
  policy: JudgeAggregationPolicy;
  winsA: number;
  winsB: number;
  ties: number;
  winner: JudgeWinner;
  perTask: TaskVerdict[];
};
