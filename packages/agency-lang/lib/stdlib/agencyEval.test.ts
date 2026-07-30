import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _finalizeInput,
  _finishEvalRun,
  _formatEvalRunFailure,
  _initEvalRun,
  _evalJudgeSuite,
  _prepareInput,
} from "./agencyEval.js";

describe("agency eval stdlib helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-eval-stdlib-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes runs with generated ids and reports prepare failures", () => {
    const state = _initEvalRun(
      { moduleId: "agent" },
      [{ id: "../escape", goal: "g", args: {} }],
      "main",
      tmpDir,
      "",
      true,
    );
    expect(state.runId).not.toBe("");

    const prep = _prepareInput(state, state.inputs[0]);
    expect(prep.ok).toBe(false);
    if (!prep.ok) {
      expect(prep.result).toMatchObject({
        inputId: "../escape",
        status: "error",
      });
    }

    const summary = _finishEvalRun(state, prep.ok ? [] : [prep.result]);
    expect(summary.errorCount).toBe(1);
    expect(fs.existsSync(path.join(state.runDir, "summary.json"))).toBe(true);
  });

  it("finalizes prepared inputs with success or error results", async () => {
    const state = _initEvalRun(
      { moduleId: "agent" },
      [{ id: "t1", goal: "g", args: {} }],
      "main",
      tmpDir,
      "r1",
      true,
    );
    const prep = _prepareInput(state, state.inputs[0]);
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;

    // No statelog file written → finalize skips extraction and succeeds.
    const success = await _finalizeInput(prep.prepared, "");
    const error = await _finalizeInput(prep.prepared, "boom");

    expect(success).toMatchObject({ inputId: "t1", status: "success" });
    expect(error).toMatchObject({ inputId: "t1", status: "error", errorMessage: "boom" });
  });

  it("formats failure-like values", () => {
    expect(_formatEvalRunFailure({ value: { message: "limit" } })).toBe("limit");
    expect(_formatEvalRunFailure({ error: { message: "boom" } })).toBe("boom");
    expect(_formatEvalRunFailure("plain")).toBe("plain");
  });

  it("delegates suite judging to the core judgeSuite helper", async () => {
    const result = await _evalJudgeSuite(
      "run-a",
      "run-b",
      5,
      60,
      1,
      "none",
      async (args) => ({
        verdictVersion: 2,
        generatedAt: "2026-06-11T00:00:00.000Z",
        policy: args.policy,
        winsA: 0,
        winsB: 1,
        ties: 0,
        winner: "B",
        perInput: [],
      }),
    );

    expect(result).toMatchObject({
      winner: "B",
      policy: { samples: 5, confidenceThreshold: 60, marginThreshold: 1, positionBias: "none" },
    });
  });
});
