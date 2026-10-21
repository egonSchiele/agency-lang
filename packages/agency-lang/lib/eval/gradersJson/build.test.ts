import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import type { EvalRecord, NormalizedEvent } from "@/eval/types.js";

import { AgencyRunner } from "../grading/agencyRunner.js";
import { ChecklistJudge } from "../grading/graders/checklistJudge.js";
import { LlmJudge } from "../grading/graders/llmJudge.js";
import { EMPTY_RECORD } from "../grading/testUtils.js";
import type { Grade, GraderInput } from "../grading/types.js";
import { buildGraders } from "./build.js";
import type { GraderSpec } from "./schema.js";

function toolStart(tool: string, argsPreview: string): NormalizedEvent {
  return {
    kind: "tool_start",
    tool,
    argsPreview,
    model: null,
    tMs: 0,
    threadId: null,
    spanId: null,
    parentSpanId: null,
  };
}

function record(
  over: Partial<EvalRecord>,
  metrics: Partial<EvalRecord["metrics"]> = {},
): EvalRecord {
  return { ...EMPTY_RECORD, ...over, metrics: { ...EMPTY_RECORD.metrics, ...metrics } };
}

function input(rec: EvalRecord, workdir: string = ""): GraderInput {
  return {
    test: { id: "t", input: "x" },
    run: { output: null, traceId: "trace", workdir, record: rec },
    runAgency: new AgencyRunner({}),
  };
}

async function gradeWith(spec: GraderSpec, rec: EvalRecord, workdir?: string): Promise<Grade> {
  const [grader] = buildGraders([spec]);
  return grader.run(input(rec, workdir));
}

describe("number graders", () => {
  it("scores on a line between full and zero", async () => {
    const grade = await gradeWith(
      { kind: "number", name: "llm-calls", measure: "llmCalls", full: 0, zero: 30 },
      record({}, { llmCalls: 15 }),
    );
    expect(grade.score).toEqual({ kind: "scalar", value: 0.5 });
    expect(grade.feedback).toBe("15 LLM calls");
  });

  it("clamps outside the line", async () => {
    const over = await gradeWith(
      { kind: "number", name: "n", measure: "llmCalls", full: 0, zero: 30 },
      record({}, { llmCalls: 45 }),
    );
    expect(over.score).toEqual({ kind: "scalar", value: 0 });
    const under = await gradeWith(
      { kind: "number", name: "n", measure: "costUsd", full: 1, zero: 3 },
      record({}, { costUsdTotal: 0.5 }),
    );
    expect(under.score).toEqual({ kind: "scalar", value: 1 });
    expect(under.feedback).toBe("$0.50");
  });

  it("max is pass or fail", async () => {
    const slow = await gradeWith(
      { kind: "number", name: "s", measure: "agentSeconds", max: 300 },
      record({ durationMs: 360_000 }),
    );
    expect(slow.score).toEqual({ kind: "binary", pass: false });
    expect(slow.feedback).toBe("360s");
    const quick = await gradeWith(
      { kind: "number", name: "s", measure: "agentSeconds", max: 300 },
      record({ durationMs: 12_000 }),
    );
    expect(quick.score).toEqual({ kind: "binary", pass: true });
  });

  it("describes tokens in thousands", async () => {
    const tokensIn = await gradeWith(
      { kind: "number", name: "n", measure: "tokensIn", max: 100_000 },
      record({}, { tokensInTotal: 12_345 }),
    );
    expect(tokensIn.feedback).toBe("12k tokens in");
    const tokensOut = await gradeWith(
      { kind: "number", name: "n", measure: "tokensOut", max: 100_000 },
      record({}, { tokensOutTotal: 800 }),
    );
    expect(tokensOut.feedback).toBe("1k tokens out");
  });
});

describe("count graders", () => {
  const fetches = record({
    events: [
      toolStart("fetchMarkdown", '{"url":"a"}'),
      toolStart("fetchMarkdown", '{"url":"b"}'),
      toolStart("fetchMarkdown", '{"url":"a"}'),
      toolStart("readFile", '{"path":"x"}'),
    ],
  });

  it("repeated tool calls match on tool and argsPreview", async () => {
    const grade = await gradeWith(
      {
        kind: "count",
        name: "r",
        count: "toolCalls",
        tool: "fetchMarkdown",
        repeated: true,
        max: 0,
      },
      fetches,
    );
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("1 matching row, max 0");
  });

  it("counts every call of a tool without repeated", async () => {
    const grade = await gradeWith(
      { kind: "count", name: "r", count: "toolCalls", tool: "fetchMarkdown", max: 3 },
      fetches,
    );
    expect(grade.score).toEqual({ kind: "binary", pass: true });
    expect(grade.feedback).toBe("3 matching rows, max 3");
  });

  it("two calls that differ only after the 200-character preview count as repeated", async () => {
    const preview = "x".repeat(200);
    const grade = await gradeWith(
      { kind: "count", name: "r", count: "toolCalls", repeated: true, max: 0 },
      record({ events: [toolStart("fetch", preview), toolStart("fetch", preview)] }),
    );
    expect(grade.score).toEqual({ kind: "binary", pass: false });
  });

  it("errors by message prefix", async () => {
    const grade = await gradeWith(
      {
        kind: "count",
        name: "e",
        count: "errors",
        messageStartsWith: "Unknown named argument",
        max: 0,
      },
      record({
        errors: [
          { tMs: 0, errorType: "Error", message: "Unknown named argument: foo", spanId: null },
          { tMs: 0, errorType: "Error", message: "something else", spanId: null },
        ],
      }),
    );
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("1 matching row, max 0");
  });

  it("llm calls", async () => {
    const llm: NormalizedEvent = {
      kind: "llm",
      model: "m",
      tools: [],
      durationMs: null,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
      tMs: 0,
      threadId: null,
      spanId: null,
      parentSpanId: null,
    };
    const grade = await gradeWith(
      { kind: "count", name: "l", count: "llmCalls", max: 1 },
      record({ events: [llm, llm] }),
    );
    expect(grade.score).toEqual({ kind: "binary", pass: false });
  });
});

describe("command graders", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "graders-json-cmd-"));

  it("exit 0 passes with the output as feedback", async () => {
    const grade = await gradeWith(
      { kind: "command", name: "c", command: "echo hi" },
      EMPTY_RECORD,
      workdir,
    );
    expect(grade.score).toEqual({ kind: "binary", pass: true });
    expect(grade.feedback).toBe("hi\n");
  });

  it("runs in the workdir", async () => {
    fs.writeFileSync(path.join(workdir, "marker.txt"), "here");
    const grade = await gradeWith(
      { kind: "command", name: "c", command: "cat marker.txt" },
      EMPTY_RECORD,
      workdir,
    );
    expect(grade.feedback).toBe("here");
  });

  it("non-zero exit fails", async () => {
    const grade = await gradeWith(
      { kind: "command", name: "c", command: "echo bad >&2; exit 3" },
      EMPTY_RECORD,
      workdir,
    );
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("bad\n");
  });

  it("a command that reads stdin does not hang", async () => {
    const grade = await gradeWith(
      { kind: "command", name: "c", command: "cat", timeoutSec: 5 },
      EMPTY_RECORD,
      workdir,
    );
    expect(grade.score).toEqual({ kind: "binary", pass: true });
  });

  it("a command past its timeout fails and says so", async () => {
    const grade = await gradeWith(
      { kind: "command", name: "c", command: "sleep 5", timeoutSec: 1 },
      EMPTY_RECORD,
      workdir,
    );
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("timed out after 1s");
  });

  it("no workdir fails with a message", async () => {
    const grade = await gradeWith(
      { kind: "command", name: "c", command: "true" },
      EMPTY_RECORD,
      "",
    );
    expect(grade.score).toEqual({ kind: "binary", pass: false });
    expect(grade.feedback).toBe("no working directory was captured");
  });
});

describe("buildGraders", () => {
  it("passes name, weight and mustPass through", () => {
    const [grader] = buildGraders([
      { kind: "command", name: "roundtrip", command: "true", weight: 0.5, mustPass: true },
    ]);
    expect(grader.name()).toBe("roundtrip");
    expect(grader.weight()).toBe(0.5);
    expect(grader.mustPass()).toBe(true);
    const [plain] = buildGraders([{ kind: "command", name: "p", command: "true" }]);
    expect(plain.weight()).toBe(1);
    expect(plain.mustPass()).toBe(false);
  });
});

describe("goal and checklist builders", () => {
  it("goalGrader builds an LlmJudge with the goal and passing score", () => {
    const [judge] = buildGraders([
      {
        kind: "goal",
        name: "takes-a-position",
        goal: "decides",
        mustPass: true,
        passingScore: 0.5,
      },
    ]);
    expect(judge).toBeInstanceOf(LlmJudge);
    expect(judge.name()).toBe("takes-a-position");
    expect(judge.mustPass()).toBe(true);
    expect(judge.passes({ score: { kind: "scalar", value: 0.4 } })).toBe(false);
    expect(judge.passes({ score: { kind: "scalar", value: 0.6 } })).toBe(true);
    expect(() => judge.validateInput({ id: "t" })).not.toThrow();
  });

  it("checklistGrader builds a ChecklistJudge with the points and context", () => {
    const [judge] = buildGraders([
      { kind: "checklist", name: "grounded", points: ["a", "b"], context: "notes.md", weight: 2 },
    ]);
    expect(judge).toBeInstanceOf(ChecklistJudge);
    expect(judge.name()).toBe("grounded");
    expect(judge.weight()).toBe(2);
    expect(judge.describe()).toContain("2 points");
  });
});
