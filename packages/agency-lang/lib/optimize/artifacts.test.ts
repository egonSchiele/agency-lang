import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOptimizeArtifacts } from "./artifacts.js";

describe("createOptimizeArtifacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "optimize-artifacts-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes config and baseline artifacts for an in-memory agent filename", () => {
    const artifacts = createOptimizeArtifacts({
      runsDir: path.join(tmpDir, "optimize-runs"),
      runId: "run-1",
      agentFilename: "generated/classifier.agency",
      workingDir: tmpDir,
      goal: "classify well",
      iterations: 3,
      judgeSamples: 1,
      acceptThreshold: 0,
      mutatorModel: "test-model",
      sourceSha256: "abc123",
    });

    const baseline = artifacts.writeBaseline("node main() {}\n");

    expect(JSON.parse(fs.readFileSync(path.join(artifacts.runDir, "config.json"), "utf-8"))).toMatchObject({
      runId: "run-1",
      goal: "classify well",
      agentFilename: "generated/classifier.agency",
      workingDir: tmpDir,
    });
    expect(fs.readFileSync(baseline.agentPath, "utf-8")).toBe("node main() {}\n");
    expect(fs.existsSync(path.join(baseline.workspaceAgentPath))).toBe(true);
  });

  it("preserves workingDir files while excluding the active run directory", () => {
    fs.writeFileSync(path.join(tmpDir, "helper.agency"), "def helper() {}\n");
    const artifacts = createOptimizeArtifacts({
      runsDir: path.join(tmpDir, "optimize-runs"),
      runId: "run-1",
      agentFilename: "agent.agency",
      workingDir: tmpDir,
      goal: "goal",
      iterations: 1,
      judgeSamples: 1,
      acceptThreshold: 0,
      sourceSha256: "abc123",
    });
    fs.mkdirSync(path.join(artifacts.runDir, "should-not-copy"), { recursive: true });
    fs.writeFileSync(path.join(artifacts.runDir, "should-not-copy", "x.txt"), "x");

    const baseline = artifacts.writeBaseline("node main() {}\n");

    expect(fs.existsSync(path.join(baseline.workspaceDir, "helper.agency"))).toBe(true);
    expect(fs.existsSync(path.join(baseline.workspaceDir, "optimize-runs", "run-1", "should-not-copy", "x.txt"))).toBe(false);
  });

  it("writes candidate, validation failure, runtime rejection, verdict, champion, and summary domain artifacts", () => {
    const artifacts = createOptimizeArtifacts({
      runsDir: path.join(tmpDir, "runs"),
      runId: "run-1",
      agentFilename: "agent.agency",
      workingDir: tmpDir,
      goal: "goal",
      iterations: 1,
      judgeSamples: 1,
      acceptThreshold: 0,
      sourceSha256: "abc123",
    });

    const candidate = artifacts.writeCandidate(1, "candidate", { rationale: "Changed wording." });
    const validation = artifacts.writeValidationFailure(2, { attemptedPrompt: "bad", error: "missing ${text}" });
    const errorPath = artifacts.writeRuntimeRejection(3, new Error("judge failed"));
    const verdictPath = artifacts.writeVerdict(1, {
      iter: 1,
      championIter: "baseline",
      judgeSamples: 1,
      acceptThreshold: 0,
      perTask: [],
      wins: 0,
      losses: 0,
      ties: 0,
      margin: 0,
      decision: "rejected",
      mutationSummary: "Changed wording.",
    });
    const championPath = artifacts.writeFinalChampion("champion", 1);
    const summaryPath = artifacts.writeSummary({
      runId: "run-1",
      runDir: artifacts.runDir,
      championIter: 1,
      championSource: "champion",
      acceptedCount: 1,
      rejectedCount: 0,
      validationFailedCount: 1,
      iterations: [],
    });

    expect(fs.readFileSync(candidate.mutationPath ?? "", "utf-8")).toContain("Changed wording.");
    expect(fs.readFileSync(validation.mutationPath ?? "", "utf-8")).toContain("missing ${text}");
    expect(fs.readFileSync(errorPath, "utf-8")).toContain("judge failed");
    expect(JSON.parse(fs.readFileSync(verdictPath, "utf-8"))).toMatchObject({ decision: "rejected" });
    expect(fs.readFileSync(championPath, "utf-8")).toBe("champion");
    expect(JSON.parse(fs.readFileSync(summaryPath, "utf-8"))).toMatchObject({ acceptedCount: 1 });
  });
});
