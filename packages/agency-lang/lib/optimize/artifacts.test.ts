import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOptimizeArtifacts, type OptimizeArtifacts } from "./artifacts.js";
import type { OptimizeMutationPreview } from "./sourceMutator.js";
import type { OptimizeTargetSet } from "./targets.js";

describe("createOptimizeArtifacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "optimize-artifacts-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeArtifacts(overrides: { runsDir?: string; runId?: string } = {}): OptimizeArtifacts {
    return createOptimizeArtifacts({
      runsDir: overrides.runsDir ?? path.join(tmpDir, "runs"),
      runId: overrides.runId ?? "run-1",
      workingDir: tmpDir,
      entryFile: "agent.agency",
      node: "main",
      inputsSource: "inline:--goal",
      iterations: 3,
      judgePolicy: { samples: 3, confidenceThreshold: 50, marginThreshold: 0, positionBias: "swap" },
      mutatorModel: "test-model",
    });
  }

  it("writes config.json and throws on run directory collision", () => {
    const artifacts = makeArtifacts();

    expect(JSON.parse(fs.readFileSync(path.join(artifacts.runDir, "config.json"), "utf-8"))).toMatchObject({
      runId: "run-1",
      entryFile: "agent.agency",
      node: "main",
      inputsSource: "inline:--goal",
      iterations: 3,
      judgePolicy: { samples: 3 },
      mutatorModel: "test-model",
      workingDir: tmpDir,
    });
    expect(() => makeArtifacts()).toThrow(/already exists/i);
  });

  it("writes the target set to targets.json", () => {
    const artifacts = makeArtifacts();
    const targetSet: OptimizeTargetSet = {
      baseDir: tmpDir,
      entryFile: "agent.agency",
      files: {},
      targets: [{
        id: "agent.agency:global:prompt",
        kind: "variable",
        file: "agent.agency",
        absoluteFile: path.join(tmpDir, "agent.agency"),
        scope: "global",
        name: "prompt",
        valueKind: "string",
        value: "hi",
      }],
    };

    const targetsPath = artifacts.writeTargets(targetSet);

    expect(targetsPath).toBe(path.join(artifacts.runDir, "targets.json"));
    expect(JSON.parse(fs.readFileSync(targetsPath, "utf-8"))).toMatchObject({
      entryFile: "agent.agency",
      targets: [{ id: "agent.agency:global:prompt" }],
    });
  });

  it("materializes iteration workspaces from the working dir plus the candidate file set", () => {
    fs.writeFileSync(path.join(tmpDir, "helper.agency"), "def helper() {}\n");
    fs.writeFileSync(path.join(tmpDir, "agent.agency"), "old source\n");
    const artifacts = makeArtifacts();
    fs.mkdirSync(path.join(artifacts.runDir, "should-not-copy"), { recursive: true });
    fs.writeFileSync(path.join(artifacts.runDir, "should-not-copy", "x.txt"), "x");

    const workspace = artifacts.writeIterationWorkspace(0, { "agent.agency": "candidate source\n" });

    expect(workspace.workspaceDir).toBe(path.join(artifacts.runDir, "iter-0", "workspace"));
    expect(fs.readFileSync(path.join(workspace.workspaceDir, "agent.agency"), "utf-8")).toBe("candidate source\n");
    expect(fs.existsSync(path.join(workspace.workspaceDir, "helper.agency"))).toBe(true);
    expect(fs.existsSync(path.join(workspace.workspaceDir, "runs", "run-1", "should-not-copy", "x.txt"))).toBe(false);
  });

  it("excludes heavy/irrelevant entries from iteration workspaces", () => {
    fs.writeFileSync(path.join(tmpDir, "helper.agency"), "def helper() {}\n");
    for (const dir of [".git", ".worktrees", "node_modules", "runs", ".agency-tmp", ".js-tmp", ".agency-memory"]) {
      fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, dir, "large.txt"), "x");
    }
    fs.mkdirSync(path.join(tmpDir, "dist", "lib"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "dist", "lib", "index.js"), "export {}\n");
    // package.json must be excluded so the agent's bare `agency-lang` self-import
    // climbs to the real package root instead of binding to the workspace's absent dist/.
    fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"agency-lang"}');
    const artifacts = makeArtifacts({ runsDir: path.join(tmpDir, "optimize-runs") });

    const workspace = artifacts.writeIterationWorkspace(0, {});

    expect(fs.existsSync(path.join(workspace.workspaceDir, "helper.agency"))).toBe(true);
    expect(fs.existsSync(path.join(workspace.workspaceDir, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(workspace.workspaceDir, "package.json"))).toBe(false);
    for (const dir of [".git", ".worktrees", "node_modules", "runs", ".agency-tmp", ".js-tmp", ".agency-memory"]) {
      expect(fs.existsSync(path.join(workspace.workspaceDir, dir, "large.txt"))).toBe(false);
    }
  });

  it("writes iteration agent file sets and mutation preview artifacts", () => {
    const artifacts = makeArtifacts();
    const preview: OptimizeMutationPreview = {
      files: {
        "foo.agency": "optimize const prompt = \"new\"\n",
        "helpers/prompts.agency": "def helper() {}\n",
      },
      changes: [{
        target: "foo.agency:global:prompt",
        kind: "variable",
        op: "replaceInitializer",
        oldValue: "old",
        newValue: "new",
        rationale: "Clearer wording.",
      }],
      diff: "--- foo.agency\n+++ foo.agency\n- old\n+ new",
      diagnostics: [],
      targetSet: { baseDir: tmpDir, entryFile: "foo.agency", files: {}, targets: [] },
    };

    const agent = artifacts.writeIterationAgent(1, preview.files);
    const mutation = artifacts.writeMutationPreview(1, preview, "Overall rationale.");

    expect(agent.agentDir).toBe(path.join(artifacts.runDir, "iter-1", "agent"));
    expect(fs.readFileSync(path.join(agent.agentDir, "foo.agency"), "utf-8")).toBe("optimize const prompt = \"new\"\n");
    expect(fs.readFileSync(path.join(agent.agentDir, "helpers", "prompts.agency"), "utf-8")).toBe("def helper() {}\n");

    expect(mutation.mutationJsonPath).toBe(path.join(artifacts.runDir, "iter-1", "mutation.json"));
    expect(JSON.parse(fs.readFileSync(mutation.mutationJsonPath, "utf-8"))).toEqual({
      rationale: "Overall rationale.",
      changes: [{
        target: "foo.agency:global:prompt",
        kind: "variable",
        op: "replaceInitializer",
        oldValue: "old",
        newValue: "new",
        rationale: "Clearer wording.",
      }],
    });

    const markdown = fs.readFileSync(mutation.mutationMarkdownPath, "utf-8");
    expect(mutation.mutationMarkdownPath).toBe(path.join(artifacts.runDir, "iter-1", "mutation.md"));
    expect(markdown).toContain("Overall rationale.");
    expect(markdown).toContain("foo.agency:global:prompt");
    expect(markdown).toContain("old");
    expect(markdown).toContain("new");

    expect(mutation.diffPath).toBe(path.join(artifacts.runDir, "iter-1", "diff.txt"));
    expect(fs.readFileSync(mutation.diffPath, "utf-8")).toBe(preview.diff);
  });

  it("writes validation failures, runtime rejections, verdicts, champion file sets, and summaries", () => {
    const artifacts = makeArtifacts();

    const validationPath = artifacts.writeValidationFailure(2, {
      rationale: "Tried dropping a placeholder.",
      diagnostics: [{ target: "foo.agency:global:prompt", code: "interpolation-mismatch", message: "you removed ${text}" }],
    });
    const errorPath = artifacts.writeRuntimeRejection(3, new Error("judge failed"));
    const verdictPath = artifacts.writeVerdict(1, {
      verdictVersion: 2,
      generatedAt: "now",
      policy: { samples: 1, confidenceThreshold: 50, marginThreshold: 0, positionBias: "none" },
      winsA: 0,
      winsB: 1,
      ties: 0,
      winner: "B",
      perInput: [],
    });
    const championDir = artifacts.writeFinalChampion({ "agent.agency": "champion source\n" }, 1);
    const summaryPath = artifacts.writeSummary({
      runId: "run-1",
      runDir: artifacts.runDir,
      championIter: 1,
      championFiles: { "agent.agency": "champion source\n" },
      acceptedCount: 1,
      rejectedCount: 0,
      validationFailedCount: 1,
      iterations: [],
    });

    expect(fs.readFileSync(validationPath, "utf-8")).toContain("you removed ${text}");
    expect(fs.readFileSync(validationPath, "utf-8")).toContain("interpolation-mismatch");
    expect(fs.readFileSync(errorPath, "utf-8")).toContain("judge failed");
    expect(JSON.parse(fs.readFileSync(verdictPath, "utf-8"))).toMatchObject({ winner: "B", verdictVersion: 2 });
    expect(fs.readFileSync(path.join(championDir, "agent.agency"), "utf-8")).toBe("champion source\n");
    expect(fs.readFileSync(path.join(artifacts.runDir, "champion", "championIter"), "utf-8")).toBe("1");
    expect(JSON.parse(fs.readFileSync(summaryPath, "utf-8"))).toMatchObject({ acceptedCount: 1 });
  });
});
