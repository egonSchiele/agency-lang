import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalRunInputResult, Input } from "@/eval/runTypes.js";

import { AgencyRunner } from "./agencyRunner.js";
import { grader } from "./functionGrader.js";
import { gradeInput, gradeRun, type GradingContext } from "./gradeRun.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: these are mkdtemp paths outside any project
  // root, which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** A minimal eval record with `outputs` as its evalOutputs. */
function recordJson(outputs: unknown[]): string {
  return globalThis.JSON.stringify({
    traceId: "t",
    recordVersion: 2,
    formatVersion: 1,
    durationMs: 1,
    source: "s",
    evalValues: [],
    evalOutputs: outputs.map((value) => ({ value, threadId: "0", tMs: 1 })),
    threads: [],
    events: [],
    interrupts: [],
    errors: [],
    incomplete: [],
    metrics: {
      llmCalls: 1, toolStarts: 0, toolEnds: 0, models: [],
      tokensInTotal: 0, tokensOutTotal: 0, costUsdTotal: 0.01, toolCounts: {},
    },
    warnings: [],
  });
}

type Fixture = { runDir: string; result: EvalRunInputResult; input: Input };

/**
 * A run directory for one input, laid out exactly as `agency eval run` writes it.
 * `output === undefined` means the agent produced nothing; `status: "error"`
 * means the run failed and no eval record was written at all.
 */
function makeRun(args: { id: string; output?: unknown; status?: "success" | "error" }): Fixture {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "grade-run-"));
  dirs.push(runDir);
  const inputDir = path.join(runDir, "inputs", args.id);
  const workdir = path.join(inputDir, "workdir");
  fs.mkdirSync(workdir, { recursive: true });

  const status = args.status ?? "success";
  const recordPath = path.join(inputDir, "eval-record.json");
  if (status === "success") {
    fs.writeFileSync(recordPath, recordJson(args.output === undefined ? [] : [args.output]));
  } else {
    fs.writeFileSync(path.join(inputDir, "error.txt"), "boom");
  }

  const input: Input = { id: args.id, goal: "name the capital", args: {}, expected: "New Delhi" };
  fs.writeFileSync(path.join(inputDir, "input.json"), globalThis.JSON.stringify(input));

  const result: EvalRunInputResult = {
    inputId: args.id,
    status,
    evalRecordPath: recordPath,
    statelogPath: path.join(inputDir, "statelog.jsonl"),
    workdirPath: workdir,
    errorMessage: status === "error" ? "boom" : undefined,
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), globalThis.JSON.stringify({
    runId: "r", runDir, agent: "a:main", inputs: [result],
    okCount: status === "success" ? 1 : 0,
    errorCount: status === "error" ? 1 : 0,
  }));
  return { runDir, result, input };
}

function ctx(graders: ReturnType<typeof grader>[]): GradingContext {
  return { graders, runAgency: new AgencyRunner({}) };
}

describe("gradeInput", () => {
  it("gives a grader the output, workdir, and parsed record", async () => {
    const { result, input } = makeRun({ id: "a", output: "New Delhi" });
    let seen: { output?: unknown; workdir?: string; record?: any } = {};
    const spy = grader((context) => {
      seen = context;
      return 1;
    }, { name: "spy" });

    const graded = await gradeInput(input, result, ctx([spy]));

    expect(seen.output).toBe("New Delhi");
    expect(fs.existsSync(seen.workdir as string)).toBe(true);
    expect(seen.record.metrics.costUsdTotal).toBe(0.01);
    expect(graded.gatesPassed).toBe(true);
  });

  it("runs mustPass gates before advisory graders and short-circuits on failure", async () => {
    const { result, input } = makeRun({ id: "a", output: "x" });
    const order: string[] = [];
    const gate = grader(() => {
      order.push("gate");
      return false;
    }, { name: "gate", mustPass: true });
    const advisory = grader(() => {
      order.push("advisory");
      return 1;
    }, { name: "advisory" });

    const graded = await gradeInput(input, result, ctx([advisory, gate]));

    expect(order).toEqual(["gate"]);
    expect(graded.gatesPassed).toBe(false);
  });

  it("scores an input with no output 0, without throwing", async () => {
    const { result, input } = makeRun({ id: "a" });
    const never = grader(() => 1, { name: "never-runs" });

    const graded = await gradeInput(input, result, ctx([never]));

    expect(graded.grades).toEqual([]);
    expect(graded.gatesPassed).toBe(false);
    expect(graded.run).toBeNull();
    expect(graded.ungradedReason).toMatch(/no output/i);
  });
});

describe("gradeRun", () => {
  it("scores an errored input 0 and marks it gate-failed, with no eval record on disk", async () => {
    const { runDir } = makeRun({ id: "a", status: "error" });
    const never = grader(() => 1, { name: "never-runs" });

    const card = await gradeRun(runDir, ctx([never]));

    expect(card.objective()).toBe(0);
    expect(card.gatesPassed()).toBe(false);
    expect(card.perInput[0].ungradedReason).toMatch(/errored/i);
  });

  it("distinguishes a lost eval record from a failed agent run", async () => {
    const { runDir, result } = makeRun({ id: "a", output: "hello" });
    fs.rmSync(result.evalRecordPath);
    const never = grader(() => 1, { name: "never-runs" });

    const card = await gradeRun(runDir, ctx([never]));

    expect(card.perInput[0].ungradedReason).toMatch(/no eval record/i);
  });

  it("reads the input spec from disk for an in-memory result, so goal and expected survive", async () => {
    const { runDir, result } = makeRun({ id: "a", output: "hello" });
    const inMemory = {
      runId: "r", runDir, agent: "a:main", inputs: [result], okCount: 1, errorCount: 0,
    };
    let seenGoal: unknown = "not-read";
    let seenExpected: unknown = "not-read";
    const spy = grader(({ input }) => {
      seenGoal = input.goal;
      seenExpected = input.expected;
      return 1;
    }, { name: "spy" });

    await gradeRun(inMemory, ctx([spy]));

    expect(seenGoal).toBe("name the capital");
    expect(seenExpected).toBe("New Delhi");
  });

  it("produces the same scorecard from a directory path and from an in-memory result", async () => {
    const { runDir, result } = makeRun({ id: "a", output: "hello" });
    const len = grader(({ output }) => String(output).length / 10, { name: "len" });
    const inMemory = {
      runId: "r", runDir, agent: "a:main", inputs: [result], okCount: 1, errorCount: 0,
    };

    const fromPath = await gradeRun(runDir, ctx([len]));
    const fromMemory = await gradeRun(inMemory, ctx([len]));

    expect(fromPath.objective()).toBeCloseTo(0.5);
    expect(fromMemory.objective()).toBeCloseTo(0.5);
  });
});
