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

/** One side (run A or run B) of a pairwise comparison for a single input. */
export type VerdictSide = {
  path?: string;
  status: "ok" | "missing" | "failed";
  response?: string | null;
  truncated?: true;
  errorMessage?: string;
};

export type InputVerdict = {
  inputId: string;
  goal: string;
  inputs: [VerdictSide, VerdictSide];
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
  perInput: InputVerdict[];
};
