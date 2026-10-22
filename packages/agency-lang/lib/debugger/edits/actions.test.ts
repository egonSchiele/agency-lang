import { describe, expect, it } from "vitest";
import { EDIT_ACTIONS, actionsFor, actionByName, askLabel } from "./actions.js";
import { rowsFor, type StopView } from "./rows.js";
import { agentShapedCheckpoint } from "../../runtime/state/checkpointPatch/testCheckpoints.js";

function view(): StopView {
  return {
    checkpoint: agentShapedCheckpoint(),
    stop: { branchPath: [], loopStop: "round" },
    viewed: { branchPath: [], loopStop: "round" },
    moduleId: "mod",
    pending: { edits: [], applied: [] },
  };
}

describe("the action table", () => {
  it("names each action once, anchored to a pane and a row kind", () => {
    expect(EDIT_ACTIONS.map((a) => [a.name, a.anchor.pane, a.anchor.row, a.key])).toEqual([
      ["append-message", "threads", "thread", "enter"],
      ["set-local", "locals", "local", "enter"],
      ["remove-tool", "callStack", "tool", "e"],
      ["disarm-guard", "guards", "guard", "e"],
      ["set-guard-limit", "guards", "guard", "b"],
      ["set-branch-result", "branches", "branch", "e"],
    ]);
    expect(actionByName("set-local")?.name).toBe("set-local");
    expect(actionByName("nope")).toBeUndefined();
  });

  it("a thread row takes append-message; the composer asks for the text", () => {
    const row = rowsFor("threads", view())[0];
    const [action] = actionsFor(row, view());
    expect(action.name).toBe("append-message");
    expect(action.applies(row, view())).toEqual({ offered: true });
    expect(action.hint(row, view())).toBe("send");
    expect(action.sentence(row, view())).toBe("append a message to thread main (2 messages)");
    expect(action.asks).toEqual({ label: "say something to the model", kind: "text" });
    expect(action.toEdits(row, "stop", view())).toEqual([
      { op: "appendMessage", thread: { id: "m" }, text: "stop" },
    ]);
  });

  it("a local row takes set-local, with the row's frame", () => {
    const row = rowsFor("locals", view())[1];
    const [action] = actionsFor(row, view());
    expect(action.name).toBe("set-local");
    expect(action.hint(row, view())).toBe("set");
    expect(action.sentence(row, view())).toBe("set answer in main (now null)");
    expect(action.asks).toEqual({ label: "=", kind: "json" });
    expect(askLabel(action, row)).toBe("answer =");
    expect(action.toEdits(row, 5, view())).toEqual([
      { op: "setLocal", frame: { branchPath: [], depth: 1 }, name: "answer", value: 5 },
    ]);
  });

  it("an argument row takes set-local as a setArg", () => {
    const row = rowsFor("locals", view())[0];
    const [action] = actionsFor(row, view());
    expect(action.toEdits(row, "other", view())).toEqual([
      { op: "setArg", frame: { branchPath: [], depth: 1 }, name: "task", value: "other" },
    ]);
  });

  it("a tool row under the loop takes remove-tool", () => {
    const row = rowsFor("callStack", view()).find((r) => r.kind === "tool")!;
    const [action] = actionsFor(row, view());
    expect(action.name).toBe("remove-tool");
    expect(action.hint(row, view())).toBe("remove");
    expect(action.sentence(row, view())).toBe("remove search from this loop");
    expect(action.asks).toBeUndefined();
    expect(action.toEdits(row, undefined, view())).toEqual([
      { op: "removeTool", loop: { branchPath: [] }, tool: "search" },
    ]);
    expect(action.applies({ ...row, removed: true } as typeof row, view())).toEqual({
      offered: false,
      reason: "search is already removed",
    });
  });

  it("a guard row takes disarm and a new budget; a root budget takes neither", () => {
    const [research, root] = rowsFor("guards", view()).filter((r) => r.kind === "guard");
    const [disarm, budget] = actionsFor(research, view());
    expect([disarm.name, budget.name]).toEqual(["disarm-guard", "set-guard-limit"]);
    expect(disarm.sentence(research, view())).toBe("disarm the guard research (time, 10s of 1m)");
    expect(disarm.toEdits(research, undefined, view())).toEqual([
      { op: "setGuard", guard: { index: 0 }, branchPath: [], disarmed: true },
    ]);
    expect(budget.asks).toEqual({ label: "new budget (30s, 2m, or $0.50)", kind: "amount" });
    expect(budget.toEdits(research, 90000, view())).toEqual([
      { op: "setGuard", guard: { index: 0 }, branchPath: [], limit: 90000 },
    ]);
    expect(actionsFor(root, view())).toEqual([]);
    expect(disarm.applies(root, view())).toEqual({
      offered: false,
      reason: "the root budget is the host's ceiling",
    });
  });

  it("a running fork branch takes a result; a tool call's branch does not", () => {
    const rows = rowsFor("branches", view());
    const tool = rows.find((r) => r.kind === "branch" && r.key === "tool_0_abc")!;
    const fork = rows.find((r) => r.kind === "branch" && r.key === "fork_1")!;
    const [action] = actionsFor(fork, view());
    expect(action.name).toBe("set-branch-result");
    expect(action.sentence(fork, view())).toBe("give the branch fork_1 (block) a result");
    expect(action.asks).toEqual({ label: "result =", kind: "json" });
    expect(action.toEdits(fork, 7, view())).toEqual([
      { op: "setBranchResult", branch: { path: ["tool_0_abc", "fork_1"] }, value: 7 },
    ]);
    expect(action.applies(tool, view())).toEqual({
      offered: false,
      reason: "a tool call's result is the loop's to record",
    });
  });
});
