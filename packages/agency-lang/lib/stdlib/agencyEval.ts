import { judgePairwise } from "../eval/judge/pairwise.js";
import { judgeSuite, type JudgeSuiteArgs } from "../eval/judge/suite.js";
import type { PairwiseVerdict, SuiteVerdict } from "../eval/judge/types.js";
import { StatelogParser } from "../eval/statelogParser.js";
import type { EvalRecord } from "../eval/types.js";

/**
 * Stdlib binding: reads a JSONL statelog at `statelogPath` and returns its
 * structured EvalRecord (the eval record is a view of the statelog, never a
 * file). Composes the existing extractor pipeline; no separate logic here.
 */
export async function _evalExtract(statelogPath: string): Promise<EvalRecord> {
  return new StatelogParser(statelogPath).evalRecord();
}

/**
 * Stdlib binding for `eval judge`. Pairwise-judges two eval records against
 * a goal and returns the structured PairwiseVerdict. Delegates to the
 * existing `judgePairwise` so CLI and stdlib paths share judge behavior
 * (including the subprocess judge invocation through `runAgencyJudge`).
 */
export async function _evalJudge(
  goal: string,
  recordPathA: string,
  recordPathB: string,
): Promise<PairwiseVerdict> {
  return judgePairwise(goal, recordPathA, recordPathB);
}

/**
 * Stdlib binding for suite-aware eval judging. Compares two eval run
 * directories by input id and returns the suite verdict produced by the core
 * judgeSuite helper.
 */
export async function _evalJudgeSuite(
  runA: string,
  runB: string,
  samples: number,
  confidenceThreshold: number,
  marginThreshold: number,
  positionBias: string,
  judge: (args: JudgeSuiteArgs) => Promise<SuiteVerdict> = judgeSuite,
): Promise<SuiteVerdict> {
  if (positionBias !== "swap" && positionBias !== "none") {
    throw new Error('positionBias must be "swap" or "none"');
  }
  return judge({
    runA,
    runB,
    policy: { samples, confidenceThreshold, marginThreshold, positionBias },
  });
}
