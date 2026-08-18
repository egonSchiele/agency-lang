import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAgencyAgent } from "@/cli/runAgencyAgent.js";
import type { EvalRecord } from "@/eval/types.js";
import { finishedTraceLines } from "@/runDirectory/testFixtures.js";

import { judgePair, judgePairwise } from "./pairwise.js";

vi.mock("@/cli/runAgencyAgent.js", () => ({
  runAgencyAgent: vi.fn(),
}));

const mockedRunAgencyAgent = vi.mocked(runAgencyAgent);
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A record fixture as one side of a pair. */
function side(file: string): { label: string; record: EvalRecord } {
  return { label: file, record: JSON.parse(fs.readFileSync(file, "utf8")) as EvalRecord };
}

/** A single-trace statelog file whose return value is `output`
 *  (`undefined` → a trace that returned nothing). */
function statelogWith(name: string, output?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, finishedTraceLines(`trace-${name}`, { output }).join("\n") + "\n");
  return file;
}

describe("judgePairwise", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockedRunAgencyAgent.mockResolvedValue({
      data: {
        winner: "A",
        confidence: 87,
        reasoning: "A is more precise.",
      },
      stdout: "",
      stderr: "",
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    mockedRunAgencyAgent.mockReset();
    stderrSpy.mockRestore();
  });

  it("returns a verdict for two single-trace statelogs", async () => {
    const a = statelogWith("A", "New Delhi");
    const b = statelogWith("B", "Delhi");

    const verdict = await judgePairwise("name the capital of India", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "eval/judgePairwise.agency",
        node: "judgePairwise",
        args: {
          goal: "name the capital of India",
          responseA: "New Delhi",
          responseB: "Delhi",
        },
        config: {},
      }),
    );
    expect(verdict.verdictVersion).toBe(1);
    expect(verdict.goal).toBe("name the capital of India");
    expect(verdict.inputs).toEqual([
      { path: a, response: "New Delhi" },
      { path: b, response: "Delhi" },
    ]);
    expect(verdict.winner).toBe("A");
    expect(verdict.confidence).toBe(87);
    expect(verdict.reasoning).toBe("A is more precise.");
    expect(new Date(verdict.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("returns a task verdict from judgePair", async () => {
    const a = path.join(fixturesDir, "v2-A.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");

    const verdict = await judgePair({
      inputId: "capital-india",
      goal: "name the capital of India",
      sideA: side(a),
      sideB: side(b),
    });

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "eval/judgePairwise.agency",
        node: "judgePairwise",
        args: {
          goal: "name the capital of India",
          responseA: "New Delhi",
          responseB: "Delhi",
        },
        config: {},
      }),
    );
    expect(verdict).toMatchObject({
      inputId: "capital-india",
      goal: "name the capital of India",
      winner: "A",
      confidence: 87,
      samples: [{ winner: "A", confidence: 87, order: "AB" }],
      inputs: [
        { path: a, response: "New Delhi", status: "ok" },
        { path: b, response: "Delhi", status: "ok" },
      ],
    });
    expect(new Date(verdict.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("requires judgePair callers to provide a task id", async () => {
    const a = path.join(fixturesDir, "v2-A.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");

    await expect(
      judgePair({
        goal: "name the capital of India",
        sideA: side(a),
        sideB: side(b),
      } as any),
    ).rejects.toThrow(/inputId/);
    expect(mockedRunAgencyAgent).not.toHaveBeenCalled();
  });

  it("keeps swapped-order samples in judge order while mapping the task winner", async () => {
    const a = path.join(fixturesDir, "v2-A.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");

    const verdict = await judgePair({
      inputId: "capital-india",
      goal: "name the capital of India",
      sideA: side(a),
      sideB: side(b),
      order: "BA",
    });

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ responseA: "Delhi", responseB: "New Delhi" }),
      }),
    );
    expect(verdict.winner).toBe("B");
    expect(verdict.samples).toEqual([
      { winner: "A", confidence: 87, reasoning: "A is more precise.", order: "BA" },
    ]);
  });

  it("returns a verdict for legacy v1 records handed to judgePair", async () => {
    const a = path.join(fixturesDir, "v1-A.eval.json");
    const b = path.join(fixturesDir, "v1-B.eval.json");

    const verdict = await judgePair({
      inputId: "t",
      goal: "name the capital of India",
      sideA: side(a),
      sideB: side(b),
    });

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ responseA: "New Delhi", responseB: "Delhi" }),
      }),
    );
    expect(verdict.inputs.map((input) => input.response)).toEqual(["New Delhi", "Delhi"]);
  });

  it("warns and judges an empty string when a trace recorded no output", async () => {
    const a = statelogWith("no-output");
    const b = statelogWith("B", "Delhi");

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ responseA: "", responseB: "Delhi" }),
      }),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${a} has no recorded final response`),
    );
    expect(verdict.inputs[0].response).toBeNull();
  });

  it("warns and judges an empty string when a legacy record's finalResponse is null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "missing-v1.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");
    fs.writeFileSync(a, JSON.stringify({ recordVersion: 1, finalResponse: null }));

    const verdict = await judgePair({ inputId: "t", goal: "goal", sideA: side(a), sideB: side(b) });

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ responseA: "", responseB: "Delhi" }),
      }),
    );
    expect(verdict.inputs[0].response).toBeNull();
  });

  it("stringifies non-string output values", async () => {
    const a = statelogWith("object", { reply: "hello" });
    const b = statelogWith("B", "Delhi");

    const verdict = await judgePairwise("goal", a, b);

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ responseA: '{"reply":"hello"}' }),
      }),
    );
    expect(verdict.inputs[0].response).toBe('{"reply":"hello"}');
  });

  it("preserves truncated metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const a = path.join(dir, "truncated.eval.json");
    const b = path.join(fixturesDir, "v2-B.eval.json");
    fs.writeFileSync(
      a,
      JSON.stringify({
        recordVersion: 2,
        evalOutputs: [{ value: "partial", threadId: "0", tMs: 1, truncated: true }],
      }),
    );

    const verdict = await judgePair({ inputId: "t", goal: "goal", sideA: side(a), sideB: side(b) });

    expect(mockedRunAgencyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ responseA: "partial" }),
      }),
    );
    expect(verdict.inputs[0]).toEqual({
      path: a,
      response: "partial",
      truncated: true,
      status: "ok",
    });
  });

  it("throws a friendly error when a statelog file is missing", async () => {
    const missing = path.join(os.tmpdir(), "missing-agency-statelog.jsonl");

    await expect(judgePairwise("goal", missing, statelogWith("B", "Delhi"))).rejects.toThrow(
      missing,
    );
    expect(mockedRunAgencyAgent).not.toHaveBeenCalled();
  });

  it("refuses a statelog with several traces, pointing at logs extract", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-pairwise-"));
    const multi = path.join(dir, "multi.jsonl");
    fs.writeFileSync(
      multi,
      [
        ...finishedTraceLines("one", { output: "x" }),
        ...finishedTraceLines("two", { output: "y" }),
      ].join("\n") + "\n",
    );
    await expect(judgePairwise("goal", multi, statelogWith("B", "Delhi"))).rejects.toThrow(
      /2 traces/,
    );
  });

  it("rejects malformed judge confidence", async () => {
    mockedRunAgencyAgent.mockResolvedValue({
      data: { winner: "A", confidence: 101, reasoning: "too high" },
      stdout: "",
      stderr: "",
    });

    await expect(
      judgePairwise("goal", statelogWith("A", "New Delhi"), statelogWith("B", "Delhi")),
    ).rejects.toThrow(/confidence/);
  });
});
