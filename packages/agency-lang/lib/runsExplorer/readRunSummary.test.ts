import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readEvalRunPhaseOne } from "./readRunSummary.js";

describe("readEvalRunPhaseOne", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-run-summary-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRun(runDir: string, summary: unknown, config?: unknown): void {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary));
    if (config !== undefined) {
      fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify(config));
    }
  }

  const summary = {
    runId: "r1",
    runDir: "/elsewhere",
    agentLabel: "a.agency:main",
    inputs: [],
    okCount: 0,
    errorCount: 0,
  };
  const config = { runId: "r1", startedAt: "2026-08-01T10:00:00.000Z" };

  it("performs exactly two content reads: summary.json and config.json", () => {
    const runDir = path.join(tmpDir, "r1");
    writeRun(runDir, summary, config);
    const reads: string[] = [];
    const countingRead = (filePath: string): string => {
      reads.push(filePath);
      return fs.readFileSync(filePath, "utf-8");
    };

    const result = readEvalRunPhaseOne(runDir, countingRead);

    expect(result.kind).toBe("loaded");
    expect(reads.sort()).toEqual([
      path.join(runDir, "config.json"),
      path.join(runDir, "summary.json"),
    ]);
  });

  it("loads summary and config values", () => {
    const runDir = path.join(tmpDir, "r1");
    writeRun(runDir, summary, config);

    const result = readEvalRunPhaseOne(runDir);
    if (result.kind !== "loaded") {
      throw new Error(`expected loaded, got ${result.kind}`);
    }

    expect(result.value.summary.runId).toBe("r1");
    expect(result.value.config?.startedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(result.value.warnings).toEqual([]);
  });

  it("missing config.json keeps the summary and records a warning", () => {
    const runDir = path.join(tmpDir, "no-config");
    writeRun(runDir, summary);

    const result = readEvalRunPhaseOne(runDir);
    if (result.kind !== "loaded") {
      throw new Error(`expected loaded, got ${result.kind}`);
    }

    expect(result.value.config).toBeNull();
    expect(result.value.warnings).toHaveLength(1);
    expect(result.value.warnings[0]).toContain("config.json");
  });

  it("malformed config.json keeps the summary and records a warning", () => {
    const runDir = path.join(tmpDir, "bad-config");
    writeRun(runDir, summary);
    fs.writeFileSync(path.join(runDir, "config.json"), "{ torn");

    const result = readEvalRunPhaseOne(runDir);
    if (result.kind !== "loaded") {
      throw new Error(`expected loaded, got ${result.kind}`);
    }

    expect(result.value.config).toBeNull();
    expect(result.value.warnings).toHaveLength(1);
  });

  it("half-written summary.json is a typed failure, not a throw", () => {
    const runDir = path.join(tmpDir, "torn");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "summary.json"), '{"runId": "r1", "inp');

    const result = readEvalRunPhaseOne(runDir);
    if (result.kind !== "failed") {
      throw new Error("expected failed");
    }

    expect(result.runDir).toBe(runDir);
    expect(result.warning).toContain("summary.json");
  });

  it("summary that parses to a non-object is a typed failure", () => {
    const runDir = path.join(tmpDir, "scalar");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "summary.json"), "42");

    const result = readEvalRunPhaseOne(runDir);

    expect(result.kind).toBe("failed");
  });
});
