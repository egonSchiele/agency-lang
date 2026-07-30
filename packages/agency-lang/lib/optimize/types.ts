import type { InputBreakdown } from "@/eval/grading/gradeBreakdown.js";
import type { OptimizeMutationOperation } from "./sourceMutator.js";

export type OptimizeDecision = "baseline" | "accepted" | "rejected" | "validation-failed";

export type MutationProposal = {
  operations: OptimizeMutationOperation[];
  rationale: string;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export type IterationResult = {
  iter: number;
  decision: OptimizeDecision;
  agentDir?: string;
  mutationPath?: string;
  evalRunDir?: string;
  verdictPath?: string;
  /** Human-readable reason for the decision: validation diagnostics for
   *  "validation-failed", otherwise the proposal rationale. */
  detail?: string;
};

export type OptimizeResult = {
  runId: string;
  runDir: string;
  championIter: number | "baseline";
  /** The champion's full Agency file set, keyed by relative path. */
  championFiles: Record<string, string>;
  acceptedCount: number;
  rejectedCount: number;
  validationFailedCount: number;
  iterations: IterationResult[];
  /** Champion's gate-aware train objective (`scorecard.gatedObjective()`,
   *  i.e. raw objective or 0 if any `mustPass` gate failed) — set by
   *  pointwise optimizers. Matches the score optimizers use to compare
   *  candidates. */
  trainObjective?: number;
  /** Baseline candidate's gate-aware train objective, so consumers can see
   *  the improvement without re-running. Computed identically to
   *  `trainObjective` so the two are directly comparable. */
  baselineObjective?: number;
  /** Champion's validation objective, when a validation set was used (Phase 3). */
  validationObjective?: number;
  /** Per-input grade breakdown for the champion — the reward-hacking lens. */
  championBreakdown?: InputBreakdown[];
};
