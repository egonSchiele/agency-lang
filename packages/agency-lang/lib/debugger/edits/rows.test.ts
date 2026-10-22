import { describe, expect, it } from "vitest";
import { rowsFor, type StopView } from "./rows.js";
import { agentShapedCheckpoint } from "../../runtime/state/checkpointPatch/testCheckpoints.js";

function atRound(): StopView {
  return {
    checkpoint: agentShapedCheckpoint(),
    stop: { branchPath: [], loopStop: "round" },
    viewed: { branchPath: [], loopStop: "round" },
    pending: { edits: [], applied: [] },
  };
}

function inSearch(): StopView {
  const checkpoint = agentShapedCheckpoint();
  return {
    checkpoint,
    stop: { branchPath: ["tool_0_abc"], loopStop: "round" },
    viewed: { branchPath: ["tool_0_abc"], loopStop: "round" },
    pending: { edits: [], applied: [] },
  };
}

describe("rowsFor", () => {
  it("locals: the shown frame's args and locals, each with its frame address", () => {
    expect(rowsFor("locals", atRound())).toEqual([
      {
        kind: "local",
        name: "task",
        value: "research",
        arg: true,
        frame: { branchPath: [], depth: 1 },
      },
      {
        kind: "local",
        name: "answer",
        value: null,
        arg: false,
        frame: { branchPath: [], depth: 1 },
      },
    ]);
    expect(rowsFor("locals", inSearch())).toEqual([
      {
        kind: "local",
        name: "query",
        value: "grant",
        arg: true,
        frame: { branchPath: ["tool_0_abc"], depth: 1 },
      },
      {
        kind: "local",
        name: "url",
        value: "u",
        arg: false,
        frame: { branchPath: ["tool_0_abc"], depth: 1 },
      },
    ]);
  });

  it("threads: every thread the stop can see, the active one marked", () => {
    expect(rowsFor("threads", inSearch())).toEqual([
      { kind: "thread", id: "m", label: "main", active: false, messageCount: 2 },
      { kind: "thread", id: "sub", label: "search", active: true, messageCount: 1 },
    ]);
  });

  it("guards: the loop line first, then each guard with its index", () => {
    expect(rowsFor("guards", atRound())).toEqual([
      { kind: "loop", round: 1, removedTools: [], tools: ["search", "writeUp"] },
      {
        kind: "guard",
        index: 0,
        label: "research",
        dimension: "time",
        limit: 60000,
        spent: 10000,
        disarmed: false,
        root: false,
      },
      {
        kind: "guard",
        index: 1,
        label: null,
        dimension: "cost",
        limit: 1,
        spent: 0.1,
        disarmed: false,
        root: true,
      },
    ]);
  });

  it("branches and the call stack", () => {
    expect(
      rowsFor("branches", atRound()).map((r) => (r.kind === "branch" ? [r.key, r.status] : r.kind)),
    ).toEqual([
      ["tool_0_abc", "running"],
      ["fork_1", "running"],
      ["fork_2", "interrupted"],
    ]);
    expect(rowsFor("callStack", inSearch())).toEqual([
      { kind: "frame", scopeName: "main", frame: { branchPath: ["tool_0_abc"], depth: 3 } },
      { kind: "frame", scopeName: "llm()", frame: { branchPath: ["tool_0_abc"], depth: 2 } },
      { kind: "frame", scopeName: "search", frame: { branchPath: ["tool_0_abc"], depth: 1 } },
      { kind: "frame", scopeName: "llm()", frame: { branchPath: ["tool_0_abc"], depth: 0 } },
    ]);
  });

  it("globals: the module's globals in the store the view reads", () => {
    expect(rowsFor("globals", inSearch())).toEqual([
      { kind: "global", module: "mod", name: "x", value: 2, branchPath: ["tool_0_abc"] },
    ]);
  });
});
