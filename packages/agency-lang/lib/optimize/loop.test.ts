import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import type { EvalRunResult } from "@/eval/runTypes.js";
import type { SuiteVerdict } from "@/eval/judge/types.js";

import { optimizeLoop, type OptimizeLoopDeps } from "./loop.js";
import type { MutationProposal, OptimizeLoopConfig } from "./types.js";
import { discoverOptimizeTargets, type OptimizeTargetSet } from "./targets.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimize-loop-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ENTRY_SOURCE = `optimize const prompt = "original"

node main() {
  return prompt
}
`;

function discoverFixture(dir: string): OptimizeTargetSet {
  const entry = path.join(dir, "agent.agency");
  fs.writeFileSync(entry, ENTRY_SOURCE);
  return discoverOptimizeTargets(entry, { baseDir: dir });
}

function makeConfig(dir: string, targetSet: OptimizeTargetSet, overrides: {
  iterations?: number;
  writeback?: boolean;
} = {}): OptimizeLoopConfig {
  return {
    runtime: {
      config: {},
      inputs: [{ id: "task-1", goal: "Return Paris", args: {} }],
      inputsSource: "inline:--goal",
    },
    target: {
      entryFile: targetSet.entryFile,
      node: "main",
      targetSet,
      workingDir: targetSet.baseDir,
      writeback: overrides.writeback ?? false,
    },
    policy: { iterations: overrides.iterations ?? 1, mutatorModel: undefined },
    judgePolicy: { samples: 1, confidenceThreshold: 50, marginThreshold: 0, positionBias: "none" },
    artifacts: { runsDir: path.join(dir, "runs"), runId: "run" },
  };
}

function proposal(value: string, target = "agent.agency:global:prompt"): MutationProposal {
  return {
    operations: [{ target, kind: "variable", op: "replaceInitializer", value, rationale: "per-op" }],
    rationale: "overall rationale",
  };
}

function fakeEvalResult(runDir: string): EvalRunResult {
  return {
    runId: "eval-run",
    runDir,
    agent: "agent",
    inputs: [{
      inputId: "task-1",
      status: "success",
      evalRecordPath: path.join(runDir, "task-1.eval.json"),
      statelogPath: "",
      workdirPath: "",
    }],
    okCount: 1,
    errorCount: 0,
  };
}

function verdict(winner: SuiteVerdict["winner"]): SuiteVerdict {
  return {
    verdictVersion: 2,
    generatedAt: "now",
    policy: { samples: 1, confidenceThreshold: 50, marginThreshold: 0, positionBias: "none" },
    winsA: winner === "A" ? 1 : 0,
    winsB: winner === "B" ? 1 : 0,
    ties: winner === "tie" ? 1 : 0,
    winner,
    perInput: [],
  };
}

type DepCalls = {
  mutate: Parameters<NonNullable<OptimizeLoopDeps["mutate"]>>[0][];
  evalRun: { agent: string; runsDir: string; runId: string }[];
  judgeSuite: Parameters<NonNullable<OptimizeLoopDeps["judgeSuite"]>>[0][];
};

function makeDeps(args: {
  proposals?: MutationProposal[];
  winners?: SuiteVerdict["winner"][];
  evalRunError?: (call: number) => Error | null;
  judgeError?: Error;
} = {}): { deps: OptimizeLoopDeps; calls: DepCalls } {
  const calls: DepCalls = { mutate: [], evalRun: [], judgeSuite: [] };
  let evalRunCount = 0;
  const deps: OptimizeLoopDeps = {
    mutate: async (mutateArgs) => {
      calls.mutate.push(mutateArgs);
      const proposals = args.proposals ?? [proposal("\"improved\"")];
      return proposals[Math.min(calls.mutate.length - 1, proposals.length - 1)];
    },
    evalRun: async (runArgs) => {
      calls.evalRun.push({ agent: runArgs.agent, runsDir: runArgs.runsDir, runId: runArgs.runId });
      evalRunCount += 1;
      const error = args.evalRunError?.(evalRunCount);
      if (error) throw error;
      return fakeEvalResult(path.join(runArgs.runsDir, runArgs.runId));
    },
    judgeSuite: async (judgeArgs) => {
      calls.judgeSuite.push(judgeArgs);
      if (args.judgeError) throw args.judgeError;
      const winners = args.winners ?? ["B"];
      return verdict(winners[Math.min(calls.judgeSuite.length - 1, winners.length - 1)]);
    },
  };
  return { deps, calls };
}

describe("optimizeLoop", () => {
  it("throws before the baseline run when there are no targets", async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "agent.agency"), "node main() {}\n");
    const targetSet = discoverOptimizeTargets(path.join(dir, "agent.agency"), { baseDir: dir });
    const { deps, calls } = makeDeps();

    await expect(optimizeLoop(makeConfig(dir, targetSet), deps)).rejects.toThrow(/no optimize targets/i);
    expect(calls.evalRun).toHaveLength(0);
  });

  it("materializes the baseline verbatim and evaluates it from the workspace", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps, calls } = makeDeps();

    await optimizeLoop(makeConfig(dir, targetSet), deps);

    const runDir = path.join(dir, "runs", "run");
    expect(fs.readFileSync(path.join(runDir, "iter-0", "agent", "agent.agency"), "utf8")).toBe(ENTRY_SOURCE);
    expect(fs.readFileSync(path.join(runDir, "iter-0", "workspace", "agent.agency"), "utf8")).toBe(ENTRY_SOURCE);
    expect(calls.evalRun[0]).toEqual({
      agent: path.join(runDir, "iter-0", "workspace", "agent.agency"),
      runsDir: path.join(runDir, "iter-0"),
      runId: "eval-run",
    });
  });

  it("calls the mutator with the champion targets, suite tasks, and history", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const config = makeConfig(dir, targetSet);
    const { deps, calls } = makeDeps();

    await optimizeLoop(config, deps);

    expect(calls.mutate).toHaveLength(1);
    expect(calls.mutate[0].targets).toEqual(targetSet.targets);
    expect(calls.mutate[0].inputs).toBe(config.runtime.inputs);
    expect(calls.mutate[0].history).toBe("");
    expect(calls.mutate[0].diagnostics).toBeUndefined();
  });

  it("feeds rendered mutation history into subsequent mutator calls", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps, calls } = makeDeps({
      proposals: [proposal("\"first\""), proposal("\"second\"")],
      winners: ["B", "A"],
    });

    await optimizeLoop(makeConfig(dir, targetSet, { iterations: 2 }), deps);

    expect(calls.mutate[0].history).toBe("");
    expect(calls.mutate[1].history).toContain("HISTORY (most recent first):");
    expect(calls.mutate[1].history).toContain("iter 1");
    expect(calls.mutate[1].history).toContain("agent.agency:global:prompt");
  });

  it("retries the mutator once with diagnostics from a rejected preview", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps, calls } = makeDeps({
      proposals: [proposal("\"x\"", "agent.agency:global:missing"), proposal("\"improved\"")],
    });

    const result = await optimizeLoop(makeConfig(dir, targetSet), deps);

    expect(calls.mutate).toHaveLength(2);
    expect(calls.mutate[1].diagnostics?.map((entry) => entry.code)).toEqual(["unknown-target"]);
    expect(result.acceptedCount).toBe(1);
  });

  it("records a validation-failed iteration and continues after two rejected previews", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps, calls } = makeDeps({
      proposals: [
        proposal("\"x\"", "agent.agency:global:missing"),
        proposal("\"y\"", "agent.agency:global:missing"),
        proposal("\"improved\""),
      ],
    });

    const result = await optimizeLoop(makeConfig(dir, targetSet, { iterations: 2 }), deps);

    expect(result.validationFailedCount).toBe(1);
    expect(result.acceptedCount).toBe(1);
    expect(result.iterations.map((iteration) => iteration.decision)).toEqual([
      "baseline",
      "validation-failed",
      "accepted",
    ]);
    expect(calls.mutate).toHaveLength(3);
  });

  it("accepts only when the suite winner is B and adopts the preview target set", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps, calls } = makeDeps({
      proposals: [proposal("\"first\""), proposal("\"second\"")],
      winners: ["B", "A"],
    });

    const result = await optimizeLoop(makeConfig(dir, targetSet, { iterations: 2 }), deps);

    expect(result.championIter).toBe(1);
    expect(result.acceptedCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    // Champion adoption: the second mutate call sees iteration 1's value,
    // proving the loop adopted the preview's target set without re-discovery.
    expect(calls.mutate[1].targets.map((target) => target.value)).toEqual(["first"]);
    expect(result.championFiles["agent.agency"]).toContain("optimize const prompt = \"first\"");
  });

  it("rejects on tie verdicts", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps({ winners: ["tie"] });

    const result = await optimizeLoop(makeConfig(dir, targetSet), deps);

    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.championIter).toBe("baseline");
  });

  it("judges champion as A and candidate as B with the configured policy", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const config = makeConfig(dir, targetSet);
    const { deps, calls } = makeDeps();

    await optimizeLoop(config, deps);

    expect(calls.judgeSuite).toHaveLength(1);
    const judgeCall = calls.judgeSuite[0];
    expect((judgeCall.runA as EvalRunResult).runDir).toContain("iter-0");
    expect((judgeCall.runB as EvalRunResult).runDir).toContain("iter-1");
    expect(judgeCall.inputs).toBe(config.runtime.inputs);
    expect(judgeCall.policy).toBe(config.judgePolicy);
  });

  it("writes the suite verdict for each judged iteration", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps();

    await optimizeLoop(makeConfig(dir, targetSet), deps);

    const verdictPath = path.join(dir, "runs", "run", "iter-1", "verdict.json");
    expect(JSON.parse(fs.readFileSync(verdictPath, "utf8"))).toMatchObject({
      verdictVersion: 2,
      winner: "B",
    });
  });

  it("throws when the baseline eval fails", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps({ evalRunError: (call) => (call === 1 ? new Error("compile failed") : null) });

    await expect(optimizeLoop(makeConfig(dir, targetSet), deps)).rejects.toThrow(/compile failed/);
  });

  it("aborts when any baseline task fails, naming the task", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps, calls } = makeDeps();
    const failing: OptimizeLoopDeps = {
      ...deps,
      evalRun: async (runArgs) => {
        const result = await deps.evalRun!(runArgs);
        return {
          ...result,
          inputs: [
            ...result.inputs,
            { inputId: "task-2", status: "error", errorMessage: "parse error in agent", evalRecordPath: "", statelogPath: "", workdirPath: "" },
          ],
          errorCount: 1,
        };
      },
    };

    await expect(optimizeLoop(makeConfig(dir, targetSet), failing))
      .rejects.toThrow(/baseline.*task-2.*parse error in agent/is);
    expect(calls.mutate).toHaveLength(0);
  });

  it("emits reporter events for run start, decisions, and completion", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps();
    const events: string[] = [];
    const reportingDeps: OptimizeLoopDeps = {
      ...deps,
      reporter: {
        runStarted: (args) => events.push(`runStarted:${args.targetSet.targets.length}`),
        phase: (args) => events.push(`phase:${args.message}`),
        validationFailed: () => events.push("validationFailed"),
        iterationRejected: () => events.push("iterationRejected"),
        iterationDecided: (args) => events.push(`decided:${args.decision}:${args.records.map((record) => record.inputId).join(",")}`),
        runFinished: (args) => events.push(`finished:${args.writebackApplied}:${args.finalTargets.map((target) => target.value).join(",")}`),
      },
    };

    await optimizeLoop(makeConfig(dir, targetSet), reportingDeps);

    expect(events[0]).toBe("runStarted:1");
    expect(events).toContain("decided:accepted:task-1");
    // The final targets reflect the accepted candidate's values.
    expect(events.at(-1)).toBe("finished:false:improved");
    expect(events.some((event) => event.startsWith("phase:"))).toBe(true);
  });

  it("rejects the iteration and continues when a candidate eval fails", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps, calls } = makeDeps({
      evalRunError: (call) => (call === 2 ? new Error("candidate exploded") : null),
    });

    const result = await optimizeLoop(makeConfig(dir, targetSet, { iterations: 2 }), deps);

    expect(result.rejectedCount).toBe(1);
    expect(result.acceptedCount).toBe(1);
    const errorText = fs.readFileSync(path.join(dir, "runs", "run", "iter-1", "error.txt"), "utf8");
    expect(errorText).toContain("candidate exploded");
    expect(calls.judgeSuite).toHaveLength(1);
  });

  it("rejects the iteration and continues when the judge suite fails", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps({ judgeError: new Error("judge unavailable") });

    const result = await optimizeLoop(makeConfig(dir, targetSet), deps);

    expect(result.rejectedCount).toBe(1);
    expect(result.championIter).toBe("baseline");
    const errorText = fs.readFileSync(path.join(dir, "runs", "run", "iter-1", "error.txt"), "utf8");
    expect(errorText).toContain("judge unavailable");
  });

  it("writes the champion file set and summary", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps();

    const result = await optimizeLoop(makeConfig(dir, targetSet), deps);

    const runDir = path.join(dir, "runs", "run");
    expect(fs.readFileSync(path.join(runDir, "champion", "agent", "agent.agency"), "utf8"))
      .toContain("optimize const prompt = \"improved\"");
    expect(fs.readFileSync(path.join(runDir, "champion", "championIter"), "utf8")).toBe("1");
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"))).toMatchObject({
      championIter: 1,
      acceptedCount: 1,
    });
    expect(result.runDir).toBe(runDir);
  });

  it("writes the discovered target set to targets.json", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps();

    await optimizeLoop(makeConfig(dir, targetSet), deps);

    const targetsJson = JSON.parse(fs.readFileSync(path.join(dir, "runs", "run", "targets.json"), "utf8"));
    expect(targetsJson.targets.map((target: { id: string }) => target.id)).toEqual([
      "agent.agency:global:prompt",
    ]);
  });

  it("writes the champion back to source files when writeback is on", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps();

    await optimizeLoop(makeConfig(dir, targetSet, { writeback: true }), deps);

    expect(fs.readFileSync(path.join(dir, "agent.agency"), "utf8"))
      .toContain("optimize const prompt = \"improved\"");
  });

  it("does not write back a baseline champion", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps({ winners: ["A"] });

    await optimizeLoop(makeConfig(dir, targetSet, { writeback: true }), deps);

    expect(fs.readFileSync(path.join(dir, "agent.agency"), "utf8")).toBe(ENTRY_SOURCE);
  });

  it("aborts writeback without modifying files when a source changed externally", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps } = makeDeps();
    const externallyModified = "optimize const prompt = \"edited meanwhile\"\n\nnode main() {\n  return prompt\n}\n";
    const tamper: OptimizeLoopDeps = {
      ...deps,
      judgeSuite: async (args) => {
        fs.writeFileSync(path.join(dir, "agent.agency"), externallyModified);
        return deps.judgeSuite!(args);
      },
    };

    await expect(optimizeLoop(makeConfig(dir, targetSet, { writeback: true }), tamper))
      .rejects.toThrow(/modified externally/i);
    expect(fs.readFileSync(path.join(dir, "agent.agency"), "utf8")).toBe(externallyModified);
    // Artifacts were still written before writeback failed.
    expect(fs.existsSync(path.join(dir, "runs", "run", "summary.json"))).toBe(true);
  });

  it("throws on run directory collision before writing artifacts", async () => {
    const dir = makeTempDir();
    const targetSet = discoverFixture(dir);
    const { deps, calls } = makeDeps();
    fs.mkdirSync(path.join(dir, "runs", "run"), { recursive: true });

    await expect(optimizeLoop(makeConfig(dir, targetSet), deps)).rejects.toThrow(/already exists/i);
    expect(calls.evalRun).toHaveLength(0);
  });
});
