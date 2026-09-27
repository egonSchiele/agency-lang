import { describe, expect, it } from "vitest";
import { parseCases, selectCases } from "./data.js";
import { readTokenAnswer, makeTextPrompt, decisionPredictions } from "./adapters.js";
import { summarize } from "./metrics.js";
import { runBenchmark, type RecordEntry } from "./runner.js";

const row = {
  id: "one",
  state: "Please refund my purchase",
  questions: { refund: { type: "noul", instructions: "Is a refund requested?" } },
  gold: { refund: { label: "true" } },
};
const cases = () => parseCases(JSON.stringify(row));

describe("benchmark data", () => {
  it("reads JSON-encoded fields from Typed Decisions", () => {
    const parsed = parseCases(
      JSON.stringify({
        ...row,
        questions: JSON.stringify(row.questions),
        gold: JSON.stringify(row.gold),
      }),
    );
    expect(parsed[0].questions.refund.type).toBe("noul");
  });
  it("refuses missing gold, duplicate IDs, and labels outside the criteria", () => {
    expect(() => parseCases(JSON.stringify({ ...row, gold: {} }))).toThrow(/gold/i);
    expect(() => parseCases([row, row].map((item) => JSON.stringify(item)).join("\n"))).toThrow(
      /duplicate/i,
    );
    expect(() =>
      parseCases(JSON.stringify({ ...row, gold: { refund: { label: "maybe" } } })),
    ).toThrow(/label/i);
  });
  it("refuses bad probability distributions and incomplete scores", () => {
    expect(() =>
      parseCases(
        JSON.stringify({
          ...row,
          gold: { refund: { label: "true", probabilities: { true: 0.2 } } },
        }),
      ),
    ).toThrow(/probabilit/i);
    expect(() =>
      parseCases(
        JSON.stringify({
          ...row,
          questions: {
            refund: { type: "score", instructions: "Urgency", criteria: ["low", "high"] },
          },
        }),
      ),
    ).toThrow();
  });
  it("refuses inconsistent task schemas before any provider calls", () => {
    const other = {
      ...row,
      id: "two",
      questions: {
        refund: { type: "choice", instructions: "Which?", criteria: { true: "yes", false: "no" } },
      },
    };
    expect(() => parseCases([row, other].map((item) => JSON.stringify(item)).join("\n"))).toThrow(
      /inconsistent/i,
    );
  });
  it("selects a reproducible sample without mutating the input", () => {
    const input = Array.from({ length: 10 }, (_, i) => ({ ...cases()[0], id: String(i) }));
    expect(selectCases(input, 5, 7)).toEqual(selectCases(input, 5, 7));
    expect(selectCases(input, 5, 7)).not.toEqual(selectCases(input, 5, 8));
    expect(input[0].id).toBe("0");
  });
});

describe("provider normalization", () => {
  it("keeps gold out of prompts and translates codes back to labels", () => {
    const item = cases()[0];
    const prompt = makeTextPrompt(item.state, item.questions.refund);
    expect(prompt).not.toContain('"gold"');
    expect(prompt).toContain("Is a refund requested?");
    const answer = readTokenAnswer(item.questions.refund, {
      output: "B",
      toolCalls: [],
      logprobs: [
        { token: "B", logprob: Math.log(0.8), top: [{ token: "A", logprob: Math.log(0.1) }] },
      ],
    });
    expect(answer.label).toBe("true");
    expect(answer.labelMass).toBeCloseTo(0.9);
    expect(answer.probabilities?.true).toBeCloseTo(8 / 9);
  });
  it("does not turn a missing alternative into zero probability", () => {
    const answer = readTokenAnswer(cases()[0].questions.refund, {
      output: "B",
      toolCalls: [],
      logprobs: [{ token: "B", logprob: -0.1 }],
    });
    expect(answer.probabilities).toBeNull();
    expect(answer.missingLabels).toEqual(["false"]);
  });
  it("rejects prose and missing logprobs instead of guessing confidence", () => {
    expect(() =>
      readTokenAnswer(cases()[0].questions.refund, { output: "B because yes", toolCalls: [] }),
    ).toThrow();
    expect(() =>
      readTokenAnswer(cases()[0].questions.refund, { output: "B", toolCalls: [] }),
    ).toThrow(/logprob/i);
  });
  it("uses noul probability and preserves fractional score answers", () => {
    const answers = decisionPredictions(
      { refund: cases()[0].questions.refund },
      { refund: { type: "noul", noul: 0.5 } },
    );
    expect(answers.refund.label).toBe("true");
    expect(answers.refund.probabilities).toEqual({ false: 0.5, true: 0.5 });
    const score = decisionPredictions(
      { risk: { type: "score", instructions: "Risk", criteria: ["low", "high"] } },
      {
        risk: {
          type: "score",
          score: 0.7,
          confidence: 0.2,
          probabilities: { "0": 0.3, "1": 0.7 },
          legend: { "0": "low", "1": "high" },
        },
      },
    );
    expect(score.risk.score).toBe(0.7);
    expect(score.risk.label).toBe("1");
  });
});

describe("execution and metrics", () => {
  it("excludes warmups, saves failures, and limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const records: RecordEntry[] = [];
    const input = [cases()[0], { ...cases()[0], id: "two" }];
    const adapter = async () => {
      active++;
      peak = Math.max(peak, active);
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return {
        predictions: { refund: { label: "true", probabilities: { false: 0.2, true: 0.8 } } },
        requests: 1,
      };
    };
    await runBenchmark(input, adapter, { repeats: 2, warmup: 1, concurrency: 2 }, (record) =>
      records.push(record),
    );
    expect(calls).toBe(5);
    expect(peak).toBe(2);
    expect(records.filter((r) => r.kind === "result")).toHaveLength(4);
    const summary = summarize(records);
    expect(summary.tasks.refund.accuracy).toBe(1);
    expect(summary.tasks.refund.brier).toBeCloseTo(0.08);
    expect(summary.tasks.refund.accuracyInterval).toHaveLength(2);
  });
  it("counts request failures against delivered accuracy and coverage", async () => {
    const records: RecordEntry[] = [];
    await runBenchmark(
      cases(),
      async () => {
        throw new Error("offline");
      },
      { repeats: 1, warmup: 0, concurrency: 1 },
      (record) => records.push(record),
    );
    const report = summarize(records);
    expect(report.errors).toBe(1);
    expect(report.tasks.refund.accuracy).toBe(0);
    expect(report.tasks.refund.coverage).toBe(0);
    expect(report.tasks.refund.brier).toBeNull();
  });
  it("does not swallow a failed result-file write", async () => {
    await expect(
      runBenchmark(
        cases(),
        async () => ({ predictions: {}, requests: 0 }),
        { repeats: 1, warmup: 0, concurrency: 1 },
        () => {
          throw new Error("disk full");
        },
      ),
    ).rejects.toThrow("disk full");
  });
});
