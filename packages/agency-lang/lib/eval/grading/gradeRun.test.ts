import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalRunInputResult, Input } from "@/eval/runTypes.js";

import { AgencyRunner } from "./agencyRunner.js";
import { grader } from "./functionGrader.js";
import { gradeRun, type GradingContext } from "./gradeRun.js";

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
  fs.mkdirSync(path.join(inputDir, "agent"), { recursive: true });

  const status = args.status ?? "success";
  const recordPath = path.join(inputDir, "agent", "eval-record.json");
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
    statelogPath: path.join(inputDir, "agent", "statelog.jsonl"),
    workdirPath: workdir,
    errorMessage: status === "error" ? "boom" : undefined,
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), globalThis.JSON.stringify({
    runId: "r", runDir, agentLabel: "a:main", inputs: [result],
    okCount: status === "success" ? 1 : 0,
    errorCount: status === "error" ? 1 : 0,
  }));
  return { runDir, result, input };
}

function ctx(graders: ReturnType<typeof grader>[]): GradingContext {
  return { graders, runAgency: new AgencyRunner({}) };
}

describe("grading one input (through gradeRun on a suite of one)", () => {
  it("gives a grader the output, workdir, and parsed record", async () => {
    const { runDir } = makeRun({ id: "a", output: "New Delhi" });
    let seen: { output?: unknown; workdir?: string; record?: any } = {};
    const spy = grader((context) => {
      seen = context;
      return 1;
    }, { name: "spy" });

    const card = await gradeRun(runDir, ctx([spy]));

    expect(seen.output).toBe("New Delhi");
    expect(fs.existsSync(seen.workdir as string)).toBe(true);
    expect(seen.record.metrics.costUsdTotal).toBe(0.01);
    expect(card.perInput[0].gatesPassed).toBe(true);
  });

  it("runs mustPass gates before advisory graders and short-circuits on failure", async () => {
    const { runDir } = makeRun({ id: "a", output: "x" });
    const order: string[] = [];
    const gate = grader(() => {
      order.push("gate");
      return false;
    }, { name: "gate", mustPass: true });
    const advisory = grader(() => {
      order.push("advisory");
      return 1;
    }, { name: "advisory" });

    const card = await gradeRun(runDir, ctx([advisory, gate]));

    expect(order).toEqual(["gate"]);
    expect(card.perInput[0].gatesPassed).toBe(false);
  });

  it("scores an input with no output 0, without throwing", async () => {
    const { runDir } = makeRun({ id: "a" });
    const never = grader(() => 1, { name: "never-runs" });

    const card = await gradeRun(runDir, ctx([never]));

    const graded = card.perInput[0];
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

  it("scores an input with an unreadable eval record 0 instead of throwing", async () => {
    const { runDir, result } = makeRun({ id: "a", output: "hello" });
    fs.writeFileSync(result.evalRecordPath, "{ this is not json");
    const never = grader(() => 1, { name: "never-runs" });

    // The mirror of the missing-record case: one corrupt file must not take down a
    // whole pass whose agents have already run and been paid for.
    const card = await gradeRun(runDir, ctx([never]));

    expect(card.objective()).toBe(0);
    expect(card.perInput[0].ungradedReason).toMatch(/unreadable/i);
  });

  it("distinguishes no output from a missing record and from an unreadable one", async () => {
    const { runDir } = makeRun({ id: "a" });   // record present, evalOutputs empty
    const never = grader(() => 1, { name: "never-runs" });

    const card = await gradeRun(runDir, ctx([never]));

    expect(card.perInput[0].ungradedReason).toMatch(/produced no output/i);
  });

  it("distinguishes a lost eval record from a failed agent run", async () => {
    const { runDir, result } = makeRun({ id: "a", output: "hello" });
    fs.rmSync(result.evalRecordPath);
    const never = grader(() => 1, { name: "never-runs" });

    const card = await gradeRun(runDir, ctx([never]));

    expect(card.perInput[0].ungradedReason).toMatch(/no eval record/i);
  });

  it("never grades an errored run, even when a salvaged record with a plausible output exists", async () => {
    const { runDir, result } = makeRun({ id: "a", status: "error" });
    fs.writeFileSync(result.evalRecordPath, recordJson(["plausible answer"]));
    let graderRan = false;
    const spy = grader(() => {
      graderRan = true;
      return 1;
    }, { name: "spy" });

    const card = await gradeRun(runDir, ctx([spy]));

    expect(graderRan).toBe(false);
    expect(card.objective()).toBe(0);
    expect(card.perInput[0].ungradedReason).toMatch(/agent run errored/);
  });

  it("reads the input spec from the run directory, so goal and expected survive", async () => {
    const { runDir } = makeRun({ id: "a", output: "hello" });
    let seenGoal: unknown = "not-read";
    let seenExpected: unknown = "not-read";
    const spy = grader(({ input }) => {
      seenGoal = input.goal;
      seenExpected = input.expected;
      return 1;
    }, { name: "spy" });

    await gradeRun(runDir, ctx([spy]));

    expect(seenGoal).toBe("name the capital");
    expect(seenExpected).toBe("New Delhi");
  });
});
