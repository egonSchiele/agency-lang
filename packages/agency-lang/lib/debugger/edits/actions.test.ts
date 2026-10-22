import { describe, expect, it } from "vitest";
import { EDIT_ACTIONS, actionsFor, actionByName, askLabel } from "./actions.js";
import { rowsFor, type StopView } from "./rows.js";
import { agentShapedCheckpoint } from "../../runtime/state/checkpointPatch/testCheckpoints.js";

function view(): StopView {
  return {
    checkpoint: agentShapedCheckpoint(),
    stop: { branchPath: [], loopStop: "round" },
    viewed: { branchPath: [], loopStop: "round" },
    pending: { edits: [], applied: [] },
  };
}

describe("the action table", () => {
  it("names each action once, anchored to a pane and a row kind", () => {
    expect(EDIT_ACTIONS.map((a) => [a.name, a.anchor.pane, a.anchor.row, a.key])).toEqual([
      ["append-message", "threads", "thread", "enter"],
      ["set-local", "locals", "local", "enter"],
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

  it("a guard row takes nothing yet", () => {
    const row = rowsFor("guards", view())[1];
    expect(actionsFor(row, view())).toEqual([]);
  });
});
