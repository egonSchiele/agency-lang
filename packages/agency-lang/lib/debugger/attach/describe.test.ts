import { describe, it, expect } from "vitest";
import { describeAnswer, describeCommand } from "./describe.js";

describe("describeCommand", () => {
  it("words every command the way the activity line shows it", () => {
    expect(describeCommand({ type: "step" })).toBe("step");
    expect(describeCommand({ type: "next" })).toBe("next");
    expect(describeCommand({ type: "stepIn" })).toBe("step in");
    expect(describeCommand({ type: "stepOut" })).toBe("step out");
    expect(describeCommand({ type: "continue" })).toBe("continue");
    expect(describeCommand({ type: "rewind" })).toBe("rewind");
    expect(describeCommand({ type: "stepBack" })).toBe("step back");
    expect(describeCommand({ type: "showCheckpoints" })).toBe("checkpoints");
    expect(describeCommand({ type: "checkpoint" })).toBe("checkpoint");
    expect(describeCommand({ type: "checkpoint", label: "before" })).toBe("checkpoint before");
    expect(describeCommand({ type: "set", varName: "x", value: 5 })).toBe("set x = 5");
    expect(describeCommand({ type: "modify", overrides: { x: 1, y: 2 } })).toBe("set x, y");
    expect(describeCommand({ type: "approve" })).toBe("approve");
    expect(describeCommand({ type: "reject" })).toBe("reject");
    expect(describeCommand({ type: "reject", value: "no" })).toBe('reject "no"');
    expect(describeCommand({ type: "resolve", value: 7 })).toBe("resolve 7");
    expect(describeCommand({ type: "save", path: "a.json" })).toBe("save a.json");
    expect(describeCommand({ type: "load", path: "a.json" })).toBe("load a.json");
    expect(describeCommand({ type: "quit" })).toBe("quit");
  });

  it("cuts a long value short", () => {
    const long = "x".repeat(100);
    expect(describeCommand({ type: "set", varName: "s", value: long })).toHaveLength(
      "set s = ".length + 40,
    );
  });

  it("shows a reply that is not a command as it came", () => {
    expect(describeCommand(null as never)).toBe("null");
    expect(describeCommand({ type: "fly" } as never)).toBe('{"type":"fly"}');
  });
});

describe("describeAnswer", () => {
  it("words each kind of reply", () => {
    expect(describeAnswer("waitForCommand", { type: "step" })).toBe("step");
    expect(describeAnswer("render", undefined)).toBe("saw the stop");
    expect(describeAnswer("showRewindSelector", 12)).toBe("rewind to #12");
    expect(describeAnswer("showRewindSelector", null)).toBe("closed the rewind picker");
    expect(describeAnswer("answerGuardTrip", { type: "reject" })).toBe("rejected the guard trip");
    expect(describeAnswer("answerGuardTrip", { type: "approve", value: { maxCost: 0.5 } })).toBe(
      'approved the guard trip {"maxCost":0.5}',
    );
    expect(describeAnswer("showCheckpointsPanel", undefined)).toBe("closed the checkpoints panel");
    expect(describeAnswer("promptForNodeArgs", [1])).toBe("gave the node its arguments");
    expect(describeAnswer("promptForInput", "yes")).toBe('answered "yes"');
  });
});
