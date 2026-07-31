import type { Input } from "../runTypes.js";
import { readEvalRun, type ReadEvalRunInput } from "../readRun.js";
import { judgePair, type JudgePairArgs } from "./pairwise.js";
import type {
  JudgeAggregationPolicy,
  JudgeSample,
  JudgeWinner,
  SuiteVerdict,
  InputVerdict,
} from "./types.js";

/** Two run directories and a policy — the input specs (ids, goals) come from
 *  each run's own input.json files, the same way grading reads them. */
export type JudgeSuiteArgs = {
  runA: string;
  runB: string;
  policy: JudgeAggregationPolicy;
  judgePair?: (args: JudgePairArgs) => Promise<InputVerdict>;
};

export function orderForSample(index: number, positionBias: "swap" | "none"): "AB" | "BA" {
  if (positionBias === "none") return "AB";
  return index % 2 === 0 ? "AB" : "BA";
}

export function mapWinnerToOriginal(winner: JudgeWinner, order: "AB" | "BA"): JudgeWinner {
  if (winner === "tie" || order === "AB") return winner;
  return winner === "A" ? "B" : "A";
}

export function reduceSamples(args: {
  inputId: string;
  goal: string;
  samples: JudgeSample[];
  inputs: InputVerdict["inputs"];
}): InputVerdict {
  const mappedSamples = args.samples.map((sample) => ({
    ...sample,
    winner: mapWinnerToOriginal(sample.winner, sample.order),
  }));
  return {
    inputId: args.inputId,
    goal: args.goal,
    inputs: args.inputs,
    winner: winnerFromCounts(mappedSamples),
    confidence: mean(mappedSamples.map((sample) => sample.confidence)),
    reasoning: mappedSamples.map((sample) => sample.reasoning).join("\n"),
    samples: mappedSamples,
    generatedAt: new Date().toISOString(),
  };
}

export function aggregateSuite(perInput: InputVerdict[], policy: JudgeAggregationPolicy): SuiteVerdict {
  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (const verdict of perInput) {
    const countedWinner = verdict.confidence < policy.confidenceThreshold ? "tie" : verdict.winner;
    if (countedWinner === "A") {
      winsA += 1;
    } else if (countedWinner === "B") {
      winsB += 1;
    } else {
      ties += 1;
    }
  }

  return {
    verdictVersion: 2,
    generatedAt: new Date().toISOString(),
    policy,
    winsA,
    winsB,
    ties,
    winner: suiteWinner(winsA, winsB, policy.marginThreshold),
    perInput,
  };
}

export async function judgeSuite(args: JudgeSuiteArgs): Promise<SuiteVerdict> {
  const runA = readEvalRun(args.runA);
  const runB = readEvalRun(args.runB);
  const perInput: InputVerdict[] = [];
  const judge = args.judgePair ?? judgePair;

  // Run A's inputs in summary order, then any ids only run B has — a lopsided
  // pair yields missing-data verdicts rather than silently dropping inputs.
  const ids = [
    ...Object.keys(runA.inputsById),
    ...Object.keys(runB.inputsById).filter((id) => !Object.hasOwn(runA.inputsById, id)),
  ];
  for (const id of ids) {
    const inputA = runA.inputsById[id] ?? missingInput(id);
    const inputB = runB.inputsById[id] ?? missingInput(id);
    const spec: Input = inputA.input ?? inputB.input ?? { id, task: "" };
    if (inputA.status !== "ok" || inputB.status !== "ok") {
      perInput.push(missingDataVerdict(spec, inputA, inputB));
      continue;
    }
    // No goal means nothing to judge against. An LLM judge handed "" would
    // still return a confident-looking verdict, so refuse deterministically
    // instead — same treatment as missing data.
    if (!spec.goal) {
      perInput.push(noGoalVerdict(id, inputA, inputB));
      continue;
    }

    const samples: JudgeSample[] = [];
    for (let index = 0; index < args.policy.samples; index += 1) {
      const order = orderForSample(index, args.policy.positionBias);
      const verdict = await judge({
        inputId: id,
        goal: spec.goal ?? "",
        recordPathA: inputA.recordPath ?? "",
        recordPathB: inputB.recordPath ?? "",
        order,
      });
      samples.push(...verdict.samples);
    }
    perInput.push(reduceSamples({
      inputId: id,
      goal: spec.goal ?? "",
      samples,
      inputs: [verdictSideOf(inputA), verdictSideOf(inputB)],
    }));
  }

  return aggregateSuite(perInput, args.policy);
}

function winnerFromCounts(samples: JudgeSample[]): JudgeWinner {
  const winsA = samples.filter((sample) => sample.winner === "A").length;
  const winsB = samples.filter((sample) => sample.winner === "B").length;
  if (winsA > winsB) return "A";
  if (winsB > winsA) return "B";
  return "tie";
}

function suiteWinner(winsA: number, winsB: number, marginThreshold: number): JudgeWinner {
  const margin = Math.abs(winsA - winsB);
  if (margin <= marginThreshold) return "tie";
  return winsA > winsB ? "A" : "B";
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function missingInput(inputId: string): ReadEvalRunInput {
  return { inputId, status: "missing" };
}

function missingDataVerdict(input: Input, inputA: ReadEvalRunInput, inputB: ReadEvalRunInput): InputVerdict {
  const winner = missingDataWinner(inputA.status, inputB.status);
  return {
    inputId: input.id ?? "",
    goal: input.goal ?? "",
    inputs: [verdictSideOf(inputA), verdictSideOf(inputB)],
    winner,
    confidence: 100,
    reasoning: `A status: ${inputA.status}; B status: ${inputB.status}`,
    unjudgeable: true,
    samples: [{ winner, confidence: 100, reasoning: "deterministic missing-data verdict", order: "AB" }],
    generatedAt: new Date().toISOString(),
  };
}

/** Neither side can win an unjudgeable input; ties never count toward a
 *  suite winner, so a goal-less input degrades loudly in perInput without
 *  skewing the aggregate. */
function noGoalVerdict(inputId: string, inputA: ReadEvalRunInput, inputB: ReadEvalRunInput): InputVerdict {
  // "no goal recorded", not "no goal in its input.json": this branch also
  // fires when input.json is missing or unparseable (the loader degrades
  // those to a spec-less input while the records stay judgeable).
  const reasoning = "no goal recorded for this input; nothing to judge against";
  return {
    inputId,
    goal: "",
    inputs: [verdictSideOf(inputA), verdictSideOf(inputB)],
    winner: "tie",
    confidence: 100,
    reasoning,
    unjudgeable: true,
    samples: [{ winner: "tie", confidence: 100, reasoning, order: "AB" }],
    generatedAt: new Date().toISOString(),
  };
}

function missingDataWinner(statusA: ReadEvalRunInput["status"], statusB: ReadEvalRunInput["status"]): JudgeWinner {
  if (statusA === "ok" && statusB !== "ok") return "A";
  if (statusB === "ok" && statusA !== "ok") return "B";
  return "tie";
}

function verdictSideOf(input: ReadEvalRunInput): InputVerdict["inputs"][number] {
  return {
    ...(input.recordPath ? { path: input.recordPath } : {}),
    status: input.status,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}
