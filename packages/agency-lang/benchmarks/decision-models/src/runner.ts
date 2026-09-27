import { CaseRequestError, type Adapter, type Answer, type Prediction } from "./adapters.js";
import { labelsFor, type Case, type Gold } from "./data.js";

export type Observation = {
  task: string;
  type: "choice" | "noul" | "score";
  labels: string[];
  gold: Gold;
  prediction: Prediction | null;
};
export type ResultRecord = {
  kind: "result";
  caseId: string;
  trial: number;
  elapsedMs: number;
  error?: string;
  answer: Answer;
  observations: Observation[];
};
export type RecordEntry =
  | ResultRecord
  | { kind: "warmup"; index: number; elapsedMs: number; error?: string }
  | { kind: "finished"; elapsedMs: number }
  | { kind: "run"; metadata: Record<string, unknown> };
export type RunOptions = { repeats: number; warmup: number; concurrency: number };

async function attempt(item: Case, adapter: Adapter): Promise<{ answer: Answer; error?: string }> {
  try {
    return { answer: await adapter(item) };
  } catch (error) {
    const answer =
      error instanceof CaseRequestError ? error.partial : { predictions: {}, requests: 0 };
    return { answer, error: error instanceof Error ? error.message : String(error) };
  }
}

function observations(item: Case, answer: Answer): Observation[] {
  return Object.entries(item.questions).map(([name, question]) => ({
    task: item.workflow ? `${item.workflow}/${name}` : name,
    type: question.type,
    labels: labelsFor(question),
    gold: item.gold[name],
    prediction: Object.hasOwn(answer.predictions, name) ? answer.predictions[name] : null,
  }));
}

/** Timers cover the complete adapter call. Saving and scheduling also count
 * toward throughput. Warmups are saved separately and never enter metrics. */
export async function runBenchmark(
  cases: Case[],
  adapter: Adapter,
  options: RunOptions,
  save: (record: RecordEntry) => void,
): Promise<void> {
  if (
    cases.length === 0 ||
    !Number.isInteger(options.repeats) ||
    options.repeats < 1 ||
    !Number.isInteger(options.warmup) ||
    options.warmup < 0 ||
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1
  ) {
    throw new Error(
      "Cases, repeats, and concurrency must be positive; warmup must be nonnegative.",
    );
  }
  for (let index = 0; index < options.warmup; index++) {
    const started = performance.now();
    const result = await attempt(cases[index % cases.length], adapter);
    save({ kind: "warmup", index, elapsedMs: performance.now() - started, error: result.error });
    if (result.error) {
      throw new Error(`Warmup failed: ${result.error}`);
    }
  }
  const jobs = Array.from({ length: options.repeats }, (_, trial) =>
    cases.map((item) => ({ item, trial })),
  ).flat();
  let next = 0;
  let writeFailed = false;
  const started = performance.now();
  async function worker(): Promise<void> {
    while (next < jobs.length && !writeFailed) {
      const { item, trial } = jobs[next++];
      const start = performance.now();
      const result = await attempt(item, adapter);
      const record: ResultRecord = {
        kind: "result",
        caseId: item.id,
        trial,
        elapsedMs: performance.now() - start,
        ...result,
        observations: observations(item, result.answer),
      };
      try {
        save(record);
      } catch (error) {
        writeFailed = true;
        throw error;
      }
    }
  }
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker),
  );
  const failed = workers.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    throw failed.reason;
  }
  save({ kind: "finished", elapsedMs: performance.now() - started });
}
