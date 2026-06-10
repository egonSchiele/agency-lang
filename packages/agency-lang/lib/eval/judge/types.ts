export type PairwiseJudgeResult = {
  winner: "A" | "B" | "tie";
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
  winner: "A" | "B" | "tie";
  confidence: number;
  reasoning: string;
  generatedAt: string;
};
