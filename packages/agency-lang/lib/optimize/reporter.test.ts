import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import type { SuiteVerdict } from "@/eval/judge/types.js";
import { color } from "@/utils/termcolors.js";

import { createOptimizeReporter, type OptimizeReporter } from "./reporter.js";
import type { OptimizeTarget, OptimizeTargetSet } from "./targets.js";
import type { OptimizeResult } from "./types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimize-reporter-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTarget(overrides: Partial<OptimizeTarget> & { id: string; name: string }): OptimizeTarget {
  return {
    kind: "variable",
    file: "foo.agency",
    absoluteFile: "/abs/foo.agency",
    scope: "bar",
    valueKind: "string",
    value: "xyz",
    ...overrides,
  };
}

const promptTarget = makeTarget({ id: "foo.agency:bar:prompt", name: "prompt", value: "xyz" });
const systemTarget = makeTarget({
  id: "foo.agency:global:systemPrompt",
  name: "systemPrompt",
  scope: "global",
  value: "x".repeat(500),
});

const targetSet: OptimizeTargetSet = {
  baseDir: "/abs",
  entryFile: "foo.agency",
  files: {},
  targets: [promptTarget, systemTarget],
};

const verdict: SuiteVerdict = {
  verdictVersion: 2,
  generatedAt: "now",
  policy: { samples: 1, confidenceThreshold: 50, marginThreshold: 0, positionBias: "none" },
  winsA: 1,
  winsB: 2,
  ties: 0,
  winner: "B",
  perTask: [],
};

const result: OptimizeResult = {
  runId: "run",
  runDir: "/r",
  championIter: 1,
  championFiles: {},
  acceptedCount: 1,
  rejectedCount: 0,
  validationFailedCount: 0,
  iterations: [],
};

function writeRecord(dir: string, name: string, response: string): string {
  const recordPath = path.join(dir, name);
  fs.writeFileSync(recordPath, JSON.stringify({ evalOutputs: [{ value: response }] }));
  return recordPath;
}

function capture(verbosity: "silent" | "default"): { reporter: OptimizeReporter; lines: string[] } {
  const lines: string[] = [];
  const reporter = createOptimizeReporter(verbosity, (line) => lines.push(line));
  return { reporter, lines };
}

function decidedArgs(overrides: {
  iter?: number;
  changes?: { oldValue: string; newValue: string }[];
  records?: { taskId: string; championRecordPath?: string; candidateRecordPath?: string }[];
} = {}) {
  return {
    iter: overrides.iter ?? 1,
    total: 5,
    decision: "accepted" as const,
    verdict,
    changes: (overrides.changes ?? [{ oldValue: "xyz", newValue: "a better prompt" }]).map((change) => ({
      target: "foo.agency:bar:prompt",
      kind: "variable" as const,
      op: "replaceInitializer" as const,
      ...change,
      rationale: "clearer",
    })),
    rationale: "Overall clearer.",
    records: overrides.records ?? [],
  };
}

function finishedArgs(finalTargets: OptimizeTarget[] = [makeTarget({ id: "foo.agency:bar:prompt", name: "prompt", value: "a better prompt" }), systemTarget]) {
  return {
    result,
    writebackApplied: false,
    initialTargets: targetSet.targets,
    finalTargets,
  };
}

describe("createOptimizeReporter", () => {
  it("emits nothing when silent", () => {
    const { reporter, lines } = capture("silent");

    reporter.runStarted({ runId: "run", targetSet, taskCount: 1 });
    reporter.phase({ iter: 1, total: 5, message: "evaluating candidate" });
    reporter.iterationDecided(decidedArgs());
    reporter.runFinished(finishedArgs());

    expect(lines).toEqual([]);
  });

  it("does not prefix lines with a tag", () => {
    const { reporter, lines } = capture("default");

    reporter.runStarted({ runId: "run", targetSet, taskCount: 1 });
    reporter.iterationDecided(decidedArgs());

    expect(lines.join("\n")).not.toContain("[optimize]");
  });

  it("lists discovered targets with truncated values at run start", () => {
    const { reporter, lines } = capture("default");

    reporter.runStarted({ runId: "run", targetSet, taskCount: 2 });

    const text = lines.join("\n");
    expect(text).toContain("2 optimize target(s)");
    expect(text).toContain("foo.agency:bar:prompt");
    expect(text).toContain("foo.agency:global:systemPrompt");
    expect(text).not.toContain("x".repeat(200));
    expect(text).toContain("…");
  });

  it("prints phase progress", () => {
    const { reporter, lines } = capture("default");

    reporter.phase({ iter: 1, total: 5, message: "evaluating candidate" });

    expect(lines.join("\n")).toContain("Iteration 1/5: evaluating candidate");
  });

  it("separates iterations with a blank line", () => {
    const { reporter, lines } = capture("default");

    reporter.phase({ iter: 1, total: 5, message: "proposing mutation operations" });
    reporter.iterationDecided(decidedArgs({ iter: 1 }));
    reporter.phase({ iter: 2, total: 5, message: "proposing mutation operations" });

    const firstIndex = lines.indexOf("Iteration 1/5: proposing mutation operations");
    const secondIndex = lines.indexOf("Iteration 2/5: proposing mutation operations");
    expect(lines[secondIndex - 1]).toBe("");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
  });

  it("prints changed values as multi-line colored diffs", () => {
    const { reporter, lines } = capture("default");

    reporter.iterationDecided(decidedArgs());

    const text = lines.join("\n");
    expect(text).toContain("Iteration 1/5: accepted (candidate wins 2, champion wins 1, ties 0)");
    expect(text).toContain("~ foo.agency:bar:prompt:");
    expect(text).toContain(color.red("- xyz"));
    expect(text).toContain(color.green("+ a better prompt"));
    expect(text).toContain("rationale: Overall clearer.");
  });

  it("prints unchanged values dimmed without diff markers", () => {
    const { reporter, lines } = capture("default");

    reporter.iterationDecided(decidedArgs({
      changes: [{ oldValue: "same value", newValue: "same value" }],
    }));

    const text = lines.join("\n");
    expect(text).toContain(color.dim("  same value"));
    expect(text).not.toContain("- same value");
    expect(text).not.toContain("+ same value");
  });

  it("prints response diffs from eval records", () => {
    const dir = makeTempDir();
    const championRecord = writeRecord(dir, "champion.json", "Paris is the capital.");
    const candidateRecord = writeRecord(dir, "candidate.json", "Paris.");
    const { reporter, lines } = capture("default");

    reporter.iterationDecided(decidedArgs({
      records: [{ taskId: "task-1", championRecordPath: championRecord, candidateRecordPath: candidateRecord }],
    }));

    const text = lines.join("\n");
    expect(text).toContain("task-1 response:");
    expect(text).toContain("Paris");
  });

  it("notes missing responses instead of diffing them", () => {
    const { reporter, lines } = capture("default");

    reporter.iterationDecided(decidedArgs({ records: [{ taskId: "task-1" }] }));

    expect(lines.join("\n")).toContain("task-1");
    expect(lines.join("\n")).toMatch(/missing/i);
  });

  it("reports validation failures with full diagnostic messages", () => {
    const { reporter, lines } = capture("default");

    reporter.validationFailed({
      iter: 2,
      total: 5,
      diagnostics: [{ target: "t", code: "interpolation-mismatch", message: "you removed ${x} from the prompt" }],
    });
    reporter.iterationRejected({ iter: 3, total: 5, phase: "eval", error: "subprocess died" });

    const text = lines.join("\n");
    expect(text).toContain("Iteration 2/5: validation failed:");
    expect(text).toContain("[interpolation-mismatch] you removed ${x} from the prompt");
    expect(text).toContain("Iteration 3/5: rejected during eval (subprocess died)");
  });

  it("summarizes every optimized variable with start and end values at the end", () => {
    const { reporter, lines } = capture("default");

    reporter.runFinished(finishedArgs());

    const text = lines.join("\n");
    expect(text).toContain("Optimized variables:");
    expect(text).toContain("~ foo.agency:bar:prompt:");
    expect(text).toContain(color.red("- xyz"));
    expect(text).toContain(color.green("+ a better prompt"));
    // The unchanged target shows its (truncated) value dimmed.
    expect(text).toContain("~ foo.agency:global:systemPrompt:");
    expect(text).not.toContain(`- ${"x".repeat(500)}`);
    expect(text).toContain("champion iteration 1");
    expect(text).toContain("accepted 1");
  });

  it("mentions writeback when applied", () => {
    const { reporter, lines } = capture("default");

    reporter.runFinished({ ...finishedArgs(), writebackApplied: true });

    expect(lines.join("\n")).toMatch(/written back/i);
  });
});
