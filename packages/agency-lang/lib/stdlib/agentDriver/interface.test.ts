import { describe, expect, it } from "vitest";
import type { Interrupt } from "../../runtime/interrupts.js";
import { messageAnswer, pauseData, type PauseData } from "./interface.js";

const REPORTED: PauseData = {
  thread: "t1",
  cwd: "/work",
  record: null,
  models: { main: { model: "sonnet", provider: "anthropic", via: "" } },
  preset: "",
  fixedProvider: "",
  effort: "",
  budget: { maxCost: 1, maxTime: 2 },
  context: "10%",
  brain: "simple",
};

function raised(effect: string, data: unknown): Interrupt {
  return {
    type: "interrupt",
    effect,
    message: "",
    origin: "test",
    interruptId: effect,
    data,
    runId: "run",
  };
}

describe("pauseData", () => {
  it("reads what the core reports at its pause", () => {
    const pause = [raised("std::bash", {}), raised("agent::sessionInput", REPORTED)];
    expect(pauseData(pause)).toEqual(REPORTED);
  });

  it("is null when the interrupts are not the core's pause", () => {
    expect(pauseData([raised("std::bash", REPORTED)])).toBeNull();
    expect(pauseData([])).toBeNull();
  });

  it("is null when the pause's data is not the core's", () => {
    const noBudget = { ...REPORTED, budget: "lots" };
    expect(pauseData([raised("agent::sessionInput", noBudget)])).toBeNull();
  });

  it("reads a field of the wrong type as empty", () => {
    const odd = { ...REPORTED, preset: 3, record: { id: "x" } };
    expect(pauseData([raised("agent::sessionInput", odd)])).toEqual({
      ...REPORTED,
      preset: "",
      record: null,
    });
  });
});

describe("messageAnswer", () => {
  it("is a message for the main agent with no notes", () => {
    expect(messageAnswer("hi")).toEqual({ kind: "message", text: "hi", notes: [], target: "" });
  });
});
