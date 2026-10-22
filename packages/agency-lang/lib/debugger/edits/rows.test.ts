import { describe, expect, it } from "vitest";
import { rowsFor, type StopView } from "./rows.js";
import { agentShapedCheckpoint } from "../../runtime/state/checkpointPatch/testCheckpoints.js";

function atRound(): StopView {
  return {
    checkpoint: agentShapedCheckpoint(),
    stop: { branchPath: [], loopStop: "round" },
    viewed: { branchPath: [], loopStop: "round" },
    moduleId: "mod",
    pending: { edits: [], applied: [] },
  };
}

function inSearch(): StopView {
  const checkpoint = agentShapedCheckpoint();
  return {
    checkpoint,
    stop: { branchPath: ["tool_0_abc"], loopStop: "round" },
    viewed: { branchPath: ["tool_0_abc"], loopStop: "round" },
    moduleId: "mod",
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

  it("locals: an internal name is dropped from args as from locals, so rows match lines", () => {
    const view = atRound();
    view.checkpoint.stack.stack[0].args.__hidden = 1;
    view.checkpoint.stack.stack[0].locals.__substep = 2;
    expect(rowsFor("locals", view).map((row) => (row.kind === "local" ? row.name : ""))).toEqual([
      "task",
      "answer",
    ]);
  });

  it("globals: the view's module, not the checkpoint's", () => {
    const view = { ...inSearch(), moduleId: "other" };
    expect(rowsFor("globals", view)).toEqual([]);
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
        ownerLimit: 60000,
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
        ownerLimit: 1,
        disarmed: false,
        root: true,
      },
    ]);
    // Inside the tool call the research guard is the branch's clone, with
    // the parent's remaining time as its limit and the owner's as ownerLimit.
    const clone = rowsFor("guards", inSearch()).find((r) => r.kind === "guard");
    expect(clone).toMatchObject({ label: "research", limit: 50000, ownerLimit: 60000 });
  });

  it("branches and the call stack", () => {
    expect(
      rowsFor("branches", atRound()).map((r) => (r.kind === "branch" ? [r.key, r.status] : r.kind)),
    ).toEqual([
      ["tool_0_abc", "running"],
      ["fork_1", "running"],
      ["fork_2", "interrupted"],
    ]);
    // The loop's tools sit under its frame; the tool's own loop recorded
    // no names, so nothing sits under it.
    expect(rowsFor("callStack", inSearch())).toEqual([
      {
        kind: "frame",
        scopeName: "main",
        moduleId: "",
        frame: { branchPath: ["tool_0_abc"], depth: 3 },
      },
      {
        kind: "frame",
        scopeName: "llm()",
        moduleId: "",
        frame: { branchPath: ["tool_0_abc"], depth: 2 },
      },
      { kind: "tool", name: "search", removed: false, loop: { branchPath: [] } },
      { kind: "tool", name: "writeUp", removed: false, loop: { branchPath: [] } },
      {
        kind: "frame",
        scopeName: "search",
        moduleId: "",
        frame: { branchPath: ["tool_0_abc"], depth: 1 },
      },
      {
        kind: "frame",
        scopeName: "llm()",
        moduleId: "",
        frame: { branchPath: ["tool_0_abc"], depth: 0 },
      },
    ]);
  });

  it("globals: the module's globals in the store the view reads", () => {
    expect(rowsFor("globals", inSearch())).toEqual([
      { kind: "global", module: "mod", name: "x", value: 2, branchPath: ["tool_0_abc"] },
    ]);
  });
});
