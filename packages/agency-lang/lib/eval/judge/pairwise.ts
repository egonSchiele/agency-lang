import type { EvalRecord } from "@/eval/types.js";
import { evalRecordFor } from "@/runDirectory/evalRecord.js";
import { readTraces } from "@/runDirectory/traces.js";
import * as fs from "fs";

import { runAgencyAgent } from "@/cli/runAgencyAgent.js";
import type {
  JudgeSample,
  JudgeWinner,
  PairwiseJudgeResult,
  PairwiseVerdict,
  InputVerdict,
} from "./types.js";
import { selectFinalResponse } from "./selectFinalResponse.js";
import { z } from "zod";

const PairwiseJudgeResultSchema = z.object({
  winner: z.union([z.literal("A"), z.literal("B"), z.literal("tie")]),
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string(),
});

/** One side of a pair: the eval record (computed from its trace) and a label
 *  naming where it came from, for the verdict. */
export type JudgeSide = { label: string; record: EvalRecord };

export type JudgePairArgs = {
  inputId: string;
  goal: string;
  sideA: JudgeSide;
  sideB: JudgeSide;
  order?: "AB" | "BA";
};

export async function judgePair(args: JudgePairArgs): Promise<InputVerdict> {
  if (!args.inputId) throw new Error("judgePair requires inputId");
  const order = args.order ?? "AB";
  const respA = selectFinalResponse(args.sideA.record);
  const respB = selectFinalResponse(args.sideB.record);

  if (respA.missing) warnMissing(args.sideA.label);
  if (respB.missing) warnMissing(args.sideB.label);

  const judged = await runPairwiseJudge(
    args.goal,
    order === "AB" ? respA.text : respB.text,
    order === "AB" ? respB.text : respA.text,
  );
  const sample: JudgeSample = {
    winner: judged.winner,
    confidence: judged.confidence,
    reasoning: judged.reasoning,
    order,
  };
  const winner = mapWinnerToOriginal(judged.winner, order);

  return {
    inputId: args.inputId,
    goal: args.goal,
    inputs: [verdictSideOf(args.sideA.label, respA), verdictSideOf(args.sideB.label, respB)],
    winner,
    confidence: sample.confidence,
    reasoning: sample.reasoning,
    samples: [sample],
    generatedAt: new Date().toISOString(),
  };
}

/** Judge two single-trace statelog files against a goal. */
export async function judgePairwise(
  goal: string,
  statelogA: string,
  statelogB: string,
): Promise<PairwiseVerdict> {
  const verdict = await judgePair({
    inputId: "pairwise",
    goal,
    sideA: { label: statelogA, record: recordFromStatelog(statelogA) },
    sideB: { label: statelogB, record: recordFromStatelog(statelogB) },
  });

  return {
    verdictVersion: 1,
    goal,
    inputs: [pairwiseInputOf(verdict.inputs[0]), pairwiseInputOf(verdict.inputs[1])],
    winner: verdict.winner,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    generatedAt: verdict.generatedAt,
  };
}

async function runPairwiseJudge(
  goal: string,
  responseA: string,
  responseB: string,
): Promise<PairwiseJudgeResult> {
  const result = await runAgencyAgent({
    agent: "eval/judgePairwise.agency",
    node: "judgePairwise",
    args: { goal, responseA, responseB },
    config: {},
  });
  return assertPairwiseJudgeResult(result.data);
}

function assertPairwiseJudgeResult(value: unknown): PairwiseJudgeResult {
  const parsed = PairwiseJudgeResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Malformed pairwise judge result: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** The eval record of a statelog file's one trace. Several traces need a run
 *  directory (`judgeSuite`), where each trace names its test. */
function recordFromStatelog(statelogPath: string): EvalRecord {
  if (!fs.existsSync(statelogPath)) {
    throw new Error(`Statelog not found: ${statelogPath}`);
  }
  const { traces } = readTraces(statelogPath);
  if (traces.length !== 1) {
    throw new Error(
      `${statelogPath} holds ${traces.length} traces; eval judge takes a single-trace statelog ` +
        `(use \`agency logs extract\`) or two run directories.`,
    );
  }
  return evalRecordFor(traces[0], statelogPath);
}

function warnMissing(label: string): void {
  process.stderr.write(
    `warning: ${label} has no recorded final response; judging against empty string.\n`,
  );
}

function inputOf(
  filePath: string,
  response: { text: string; missing: boolean; truncated?: true },
): { path: string; response: string | null; truncated?: true } {
  return {
    path: filePath,
    response: response.missing ? null : response.text,
    ...(response.truncated ? { truncated: true as const } : {}),
  };
}

function pairwiseInputOf(input: InputVerdict["inputs"][number]): PairwiseVerdict["inputs"][number] {
  return {
    path: input.path ?? "",
    response: input.response ?? null,
    ...(input.truncated ? { truncated: true as const } : {}),
  };
}

function verdictSideOf(
  filePath: string,
  response: { text: string; missing: boolean; truncated?: true },
): InputVerdict["inputs"][number] {
  return {
    ...inputOf(filePath, response),
    status: "ok",
  };
}

function mapWinnerToOriginal(winner: JudgeWinner, order: "AB" | "BA"): JudgeWinner {
  if (winner === "tie" || order === "AB") return winner;
  return winner === "A" ? "B" : "A";
}
