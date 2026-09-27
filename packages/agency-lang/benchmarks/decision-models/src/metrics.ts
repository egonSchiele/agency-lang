import type { Observation, RecordEntry, ResultRecord } from "./runner.js";

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function quantile(values: number[], fraction: number): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

type TaskItem = Observation & { caseId: string };

/** Resample whole cases, keeping repeated trials together. This interval
 * measures example uncertainty without treating repetitions as new data. */
function accuracyInterval(items: TaskItem[]): [number, number] | null {
  const ids = items
    .map((item) => item.caseId)
    .filter((id, index, all) => all.indexOf(id) === index);
  if (ids.length < 2) {
    return null;
  }
  const groups = ids.map((id) => items.filter((item) => item.caseId === id));
  let state = 42;
  const samples = Array.from({ length: 1000 }, () => {
    let correct = 0;
    let count = 0;
    for (let i = 0; i < groups.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const group = groups[Math.floor((state / 4294967296) * groups.length)];
      correct += group.filter((item) => item.prediction?.label === item.gold.label).length;
      count += group.length;
    }
    return correct / count;
  });
  return [quantile(samples, 0.025)!, quantile(samples, 0.975)!];
}

function taskMetrics(items: TaskItem[]) {
  const labels = items[0].labels;
  if (
    items.some(
      (item) =>
        JSON.stringify(item.labels) !== JSON.stringify(labels) || item.type !== items[0].type,
    )
  ) {
    throw new Error(
      `Task ${items[0].task} has inconsistent types or label order; give distinct tasks different names.`,
    );
  }
  const confusion = labels.map((actual) => ({
    actual,
    predicted: Object.fromEntries(
      labels.map((predicted) => [
        predicted,
        items.filter((item) => item.gold.label === actual && item.prediction?.label === predicted)
          .length,
      ]),
    ),
    failed: items.filter((item) => item.gold.label === actual && !item.prediction).length,
  }));
  const f1 = labels.map((label) => {
    const tp = items.filter(
      (item) => item.gold.label === label && item.prediction?.label === label,
    ).length;
    const fp = items.filter(
      (item) => item.gold.label !== label && item.prediction?.label === label,
    ).length;
    const fn = items.filter(
      (item) => item.gold.label === label && item.prediction?.label !== label,
    ).length;
    return 2 * tp + fp + fn === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  });
  const covered = items.filter((item) => item.prediction);
  const correct = covered.filter((item) => item.prediction!.label === item.gold.label).length;
  const probabilityItems = covered.filter((item) => item.prediction!.probabilities);
  const brier = probabilityItems.map((item) =>
    labels.reduce((sum, label) => {
      const target = item.gold.probabilities?.[label] ?? Number(label === item.gold.label);
      return sum + (item.prediction!.probabilities![label] - target) ** 2;
    }, 0),
  );
  const scoreItems = covered.filter(
    (item) => item.type === "score" && item.prediction!.score !== undefined,
  );
  return {
    examples: items.length,
    uniqueCases: items
      .map((item) => item.caseId)
      .filter((id, index, all) => all.indexOf(id) === index).length,
    accuracy: correct / items.length,
    accuracyInterval: accuracyInterval(items),
    successfulAccuracy: covered.length ? correct / covered.length : null,
    coverage: covered.length / items.length,
    macroF1: mean(f1),
    confusion,
    brier: mean(brier),
    probabilityCoverage: probabilityItems.length / items.length,
    meanLabelMass: mean(
      covered.flatMap((item) =>
        item.prediction!.labelMass === undefined ? [] : [item.prediction!.labelMass],
      ),
    ),
    scoreMAE: mean(scoreItems.map((item) => Math.abs(item.prediction!.score! - item.gold.score!))),
    scoreCoverage: items[0].type === "score" ? scoreItems.length / items.length : null,
  };
}

export function summarize(records: RecordEntry[]) {
  const results = records.filter((record): record is ResultRecord => record.kind === "result");
  const items = results.flatMap((record) =>
    record.observations.map((observation) => ({ ...observation, caseId: record.caseId })),
  );
  const names = items
    .map((item) => item.task)
    .filter((name, index, all) => all.indexOf(name) === index);
  const finished = records.find((record) => record.kind === "finished");
  const successful = results.filter((record) => !record.error);
  const completedDecisions = items.filter((item) => item.prediction).length;
  const times = successful.map((record) => record.elapsedMs);
  return {
    cases: results.length,
    errors: results.length - successful.length,
    decisions: items.length,
    completedDecisions,
    requests: results.reduce((sum, record) => sum + record.answer.requests, 0),
    elapsedMs: finished?.elapsedMs ?? null,
    successfulDecisionsPerSecond:
      finished && finished.elapsedMs > 0 ? (completedDecisions * 1000) / finished.elapsedMs : null,
    latencyMs: {
      unit: "complete case",
      p50: quantile(times, 0.5),
      p95: quantile(times, 0.95),
      mean: mean(times),
    },
    failedLatencyMs: {
      p50: quantile(
        results.filter((record) => record.error).map((record) => record.elapsedMs),
        0.5,
      ),
    },
    tasks: Object.fromEntries(
      names.map((name) => [name, taskMetrics(items.filter((item) => item.task === name))]),
    ),
  };
}
