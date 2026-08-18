import * as fs from "fs";

import { describe, expect, it } from "vitest";

import { applyStatelogMerge, planStatelogMerge } from "./mergeStatelog.js";
import { runDirPaths } from "./runDir.js";
import { statelogLine, tempDir, tracesOf } from "./testFixtures.js";

describe("planStatelogMerge", () => {
  const existing = tracesOf(statelogLine("a", "agentStart"), statelogLine("b", "agentStart"));

  it("adds absent traces and skips identical ones", () => {
    const incoming = tracesOf(statelogLine("a", "agentStart"), statelogLine("c", "agentStart"));
    const plan = planStatelogMerge(existing, incoming);
    expect(plan.add.map((trace) => trace.traceId)).toEqual(["c"]);
    expect(plan.skipped).toEqual(["a"]);
    expect(plan.refused).toEqual([]);
  });

  it("refuses a trace whose id is present with different content", () => {
    const incoming = tracesOf(statelogLine("a", "agentStart", { changed: true }));
    const plan = planStatelogMerge(existing, incoming);
    expect(plan.refused).toEqual([{ traceId: "a", reason: "conflicting-digest" }]);
  });

  it("judges an incoming set against itself too", () => {
    const incoming = tracesOf(statelogLine("c", "agentStart"));
    const plan = planStatelogMerge([], [...incoming, ...incoming]);
    expect(plan.add).toHaveLength(1);
    expect(plan.skipped).toEqual(["c"]);
  });
});

describe("applyStatelogMerge", () => {
  it("appends only the added traces, verbatim, and refuses a conflicting plan", () => {
    const dir = tempDir();
    const paths = runDirPaths(dir);
    const first = statelogLine("a", "agentStart");
    fs.writeFileSync(paths.statelog, first + "\n");
    const incoming = tracesOf(
      first,
      statelogLine("b", "agentStart"),
      statelogLine("b", "agentEnd"),
    );
    const plan = planStatelogMerge(tracesOf(first), incoming);
    applyStatelogMerge(paths, plan);
    const text = fs.readFileSync(paths.statelog, "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    expect(text.startsWith(first + "\n")).toBe(true);

    const conflicting = planStatelogMerge(tracesOf(first), tracesOf(statelogLine("a", "agentEnd")));
    expect(() => applyStatelogMerge(paths, conflicting)).toThrow(/conflicts/);
    expect(fs.readFileSync(paths.statelog, "utf8")).toBe(text);
  });
});
