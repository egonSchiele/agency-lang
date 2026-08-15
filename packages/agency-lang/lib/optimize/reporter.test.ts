import { describe, expect, it } from "vitest";

import { color } from "@/utils/termcolors.js";

import { createPointwiseReporter } from "./reporter.js";
import type { OptimizeTarget, OptimizeTargetSet } from "./targets.js";
import type { OptimizeResult } from "./types.js";

function makeTarget(
  overrides: Partial<OptimizeTarget> & { id: string; name: string },
): OptimizeTarget {
  return {
    kind: "variable",
    file: "foo.agency",
    absoluteFile: "/abs/foo.agency",
    scope: "bar",
    valueKind: "string",
    declaredType: null,
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
  typeAliases: {},
  files: {},
  targets: [promptTarget, systemTarget],
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

function finishedArgs(
  finalTargets: OptimizeTarget[] = [
    makeTarget({ id: "foo.agency:bar:prompt", name: "prompt", value: "a better prompt" }),
    systemTarget,
  ],
) {
  return {
    result,
    writebackApplied: false,
    initialTargets: targetSet.targets,
    finalTargets,
  };
}

describe("createPointwiseReporter", () => {
  const prompt = makeTarget({ id: "foo.agency:bar:prompt", name: "prompt", value: "France?" });

  it("silent renders nothing", () => {
    const lines: string[] = [];
    const reporter = createPointwiseReporter("silent", (l) => lines.push(l));
    reporter.runStarted({
      optimizer: "gepa",
      runId: "r",
      targets: [prompt],
      inputCount: 2,
      iterations: 5,
    });
    reporter.baselineScored({ objective: 0.1 });
    reporter.iterationDecided({
      iter: 1,
      total: 5,
      decision: "accepted",
      objective: 0.9,
      rationale: "tightened",
    });
    reporter.note("parent: baseline");
    reporter.runFinished({
      result,
      initialTargets: [prompt],
      finalTargets: [prompt],
      durationMs: 1234,
    });
    expect(lines).toEqual([]);
  });

  it("default renders header with discovered targets, baseline, decisions with diffs, timing, and a final summary", () => {
    const lines: string[] = [];
    const reporter = createPointwiseReporter("default", (l) => lines.push(l));
    reporter.runStarted({
      optimizer: "gepa",
      runId: "abc",
      targets: [prompt],
      inputCount: 2,
      iterations: 5,
    });
    reporter.baselineScored({ objective: 0.1 });
    reporter.note("parent: baseline (objective 0.100, pool size 1)");
    reporter.iterationDecided({
      iter: 1,
      total: 5,
      decision: "accepted",
      objective: 0.9,
      rationale: "ask about India",
      changes: [
        {
          target: "foo.agency:bar:prompt",
          kind: "variable",
          op: "replaceInitializer",
          oldValue: "France?",
          newValue: "India?",
        },
      ],
      durationMs: 1500,
    });
    reporter.iterationDecided({
      iter: 2,
      total: 5,
      decision: "rejected",
      objective: 0.3,
      durationMs: 800,
    });
    reporter.iterationDecided({
      iter: 3,
      total: 5,
      decision: "validation-failed",
      rationale: "bad op",
      diagnostics: [
        {
          target: "foo.agency:bar:prompt",
          code: "interpolation-mismatch",
          message: "you removed ${x} from the prompt",
        },
      ],
    });
    reporter.runFinished({
      result,
      initialTargets: [prompt],
      finalTargets: [makeTarget({ id: "foo.agency:bar:prompt", name: "prompt", value: "India?" })],
      durationMs: 4200,
    });

    const out = lines.join("\n");
    expect(out).toMatch(/optimize gepa.*abc/);
    expect(out).toContain("foo.agency:bar:prompt"); // discovered target listed at start
    expect(out).toMatch(/baseline.*0\.100/);
    expect(out).toContain("parent: baseline"); // note() escape hatch
    expect(out).toMatch(/iter 1\/5.*accepted.*0\.900/);
    expect(out).toContain(color.red("France")); // mutation diff (word-level: "?" is unchanged)
    expect(out).toContain(color.green("India"));
    expect(out).toMatch(/1\.5s/); // per-iteration timing
    expect(out).toMatch(/iter 2\/5.*rejected.*0\.300/);
    expect(out).toMatch(/iter 3\/5.*invalid/);
    expect(out).toContain("[interpolation-mismatch]"); // validation reason surfaced
    expect(out).toContain("you removed ${x} from the prompt");
    expect(out).toContain("== Optimized variables ==");
    expect(out).toMatch(/champion iteration 1.*4\.2s/); // final summary + total time
  });
});
