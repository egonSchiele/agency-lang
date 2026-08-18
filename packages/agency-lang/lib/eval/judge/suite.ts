import { evalRecordFor, traceEnding } from "@/runDirectory/evalRecord.js";
import { readRunDirectory, type RunDirectorySnapshot } from "@/runDirectory/runDir.js";
import type { Trace } from "@/runDirectory/traces.js";

import type { EvalRecord } from "../types.js";
import type { Test } from "../runTypes.js";
import { judgePair, type JudgePairArgs } from "./pairwise.js";
import type {
  JudgeAggregationPolicy,
  JudgeSample,
  JudgeWinner,
  SuiteVerdict,
  InputVerdict,
} from "./types.js";

/** Two run directories and a policy — the tests (ids, goals) come from each
 *  directory's `run` rows, the same way grading reads them. */
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

export function aggregateSuite(
  perInput: InputVerdict[],
  policy: JudgeAggregationPolicy,
): SuiteVerdict {
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
  const runA = loadSide(args.runA);
  const runB = loadSide(args.runB);
  const perInput: InputVerdict[] = [];
  const judge = args.judgePair ?? judgePair;

  // Run A's tests in trace order, then any ids only run B has — a lopsided
  // pair yields missing-data verdicts rather than silently dropping tests.
  const ids = [
    ...Object.keys(runA.byTestId),
    ...Object.keys(runB.byTestId).filter((id) => !Object.hasOwn(runA.byTestId, id)),
  ];
  for (const id of ids) {
    const sideA = runA.byTestId[id] ?? missingSide(id);
    const sideB = runB.byTestId[id] ?? missingSide(id);
    const spec: Test = sideA.test ?? sideB.test ?? { id, input: "" };
    if (sideA.status !== "ok" || sideB.status !== "ok") {
      perInput.push(missingDataVerdict(spec, sideA, sideB));
      continue;
    }
    // No goal means nothing to judge against. An LLM judge handed "" would
    // still return a confident-looking verdict, so refuse deterministically
    // instead — same treatment as missing data.
    if (!spec.goal) {
      perInput.push(noGoalVerdict(id, sideA, sideB));
      continue;
    }

    const samples: JudgeSample[] = [];
    for (let index = 0; index < args.policy.samples; index += 1) {
      const order = orderForSample(index, args.policy.positionBias);
      const verdict = await judge({
        inputId: id,
        goal: spec.goal ?? "",
        sideA: { label: sideA.label, record: sideA.record as EvalRecord },
        sideB: { label: sideB.label, record: sideB.record as EvalRecord },
        order,
      });
      samples.push(...verdict.samples);
    }
    perInput.push(
      reduceSamples({
        inputId: id,
        goal: spec.goal ?? "",
        samples,
        inputs: [verdictSideOf(sideA), verdictSideOf(sideB)],
      }),
    );
  }

  return aggregateSuite(perInput, args.policy);
}

/** One test's trace as the judge sees it: `ok` when the run ended cleanly
 *  (the harness's `run` row is authoritative, else the trace's own ending),
 *  `failed` otherwise, `missing` when the directory has no such test. */
type JudgeSuiteSide = {
  label: string;
  status: "ok" | "failed" | "missing";
  test?: Test;
  record?: EvalRecord;
  errorMessage?: string;
};

function loadSide(dir: string): { byTestId: Record<string, JudgeSuiteSide> } {
  const snapshot = readRunDirectory(dir, { reportWarning: (m) => console.warn(`judge: ${m}`) });
  const byTestId: Record<string, JudgeSuiteSide> = Object.create(null);
  for (const trace of snapshot.traces) {
    const side = sideOf(snapshot, trace);
    const id = side.test?.id ?? trace.traceId;
    if (Object.hasOwn(byTestId, id)) {
      console.warn(`judge: ${dir} has two traces for test ${id}; keeping the first`);
      continue;
    }
    byTestId[id] = side;
  }
  return { byTestId };
}

function sideOf(snapshot: RunDirectorySnapshot, trace: Trace): JudgeSuiteSide {
  const runRow = snapshot.effectiveAnnotations[trace.traceId]?.run ?? null;
  const test =
    runRow !== null &&
    runRow.kind === "run" &&
    typeof runRow.test === "object" &&
    runRow.test !== null &&
    !Array.isArray(runRow.test)
      ? (runRow.test as Test)
      : undefined;
  const ended = runRow !== null && runRow.kind === "run" ? runRow.ended : traceEnding(trace);
  const label = `${snapshot.dir}#${trace.traceId}`;
  if (ended !== "ok") {
    const error = runRow !== null && runRow.kind === "run" ? runRow.error : undefined;
    return { label, status: "failed", test, errorMessage: error ?? `ended with ${ended}` };
  }
  return { label, status: "ok", test, record: evalRecordFor(trace, snapshot.dir) };
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

function missingSide(inputId: string): JudgeSuiteSide {
  return { label: `(no test ${inputId})`, status: "missing" };
}

function missingDataVerdict(
  input: Test,
  inputA: JudgeSuiteSide,
  inputB: JudgeSuiteSide,
): InputVerdict {
  const winner = missingDataWinner(inputA.status, inputB.status);
  return {
    inputId: input.id ?? "",
    goal: input.goal ?? "",
    inputs: [verdictSideOf(inputA), verdictSideOf(inputB)],
    winner,
    confidence: 100,
    reasoning: `A status: ${inputA.status}; B status: ${inputB.status}`,
    unjudgeable: true,
    samples: [
      { winner, confidence: 100, reasoning: "deterministic missing-data verdict", order: "AB" },
    ],
    generatedAt: new Date().toISOString(),
  };
}

/** Neither side can win an unjudgeable input; ties never count toward a
 *  suite winner, so a goal-less input degrades loudly in perInput without
 *  skewing the aggregate. */
function noGoalVerdict(
  inputId: string,
  inputA: JudgeSuiteSide,
  inputB: JudgeSuiteSide,
): InputVerdict {
  // "no goal recorded": this branch also fires for an ad-hoc trace with no
  // `run` row at all (a test named by its trace id, judgeable but goal-less).
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

function missingDataWinner(
  statusA: JudgeSuiteSide["status"],
  statusB: JudgeSuiteSide["status"],
): JudgeWinner {
  if (statusA === "ok" && statusB !== "ok") return "A";
  if (statusB === "ok" && statusA !== "ok") return "B";
  return "tie";
}

function verdictSideOf(input: JudgeSuiteSide): InputVerdict["inputs"][number] {
  return {
    path: input.label,
    status: input.status,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}
