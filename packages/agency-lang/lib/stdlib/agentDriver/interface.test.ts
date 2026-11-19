import { describe, expect, it } from "vitest";
import type { Interrupt } from "../../runtime/interrupts.js";
import {
  POLICY_UNREADABLE,
  carriedPolicy,
  messageAnswer,
  pauseData,
  type PauseData,
} from "./interface.js";

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
  policy: null,
  search: "hosted",
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

  it("reads a pause from a core that reports no search backend as an empty one", () => {
    const { search: _none, ...noSearchField } = REPORTED;
    expect(pauseData([raised("agent::sessionInput", noSearchField)])?.search).toBe("");
  });

  it("reads the policy the session carries", () => {
    const policy = { "std::edit": [{ action: "reject" }] };
    const pause = [raised("agent::sessionInput", { ...REPORTED, policy })];
    expect(pauseData(pause)?.policy).toEqual(policy);
  });

  it("reads a session started with no policy flag as carrying none", () => {
    const { policy: _none, ...noPolicyField } = REPORTED;
    expect(pauseData([raised("agent::sessionInput", noPolicyField)])?.policy).toBeNull();
  });

  it("is null when the session's policy is not a valid policy", () => {
    const odd = { ...REPORTED, policy: { "std::edit": [{ action: "maybe" }] } };
    expect(pauseData([raised("agent::sessionInput", odd)])).toBeNull();
  });
});

describe("carriedPolicy", () => {
  it("is the session's own policy, or null when it carries none", () => {
    const policy = { "std::edit": [{ action: "reject" }] };
    expect(carriedPolicy([raised("agent::sessionInput", { ...REPORTED, policy })])).toEqual({
      success: true,
      value: policy,
    });
    expect(carriedPolicy([raised("agent::sessionInput", REPORTED)])).toEqual({
      success: true,
      value: null,
    });
  });

  it("fails, saying the session can't be continued, on a policy that is not valid", () => {
    const odd = { ...REPORTED, policy: "minimal" };
    expect(carriedPolicy([raised("agent::sessionInput", odd)])).toEqual({
      success: false,
      error: POLICY_UNREADABLE,
    });
    expect(POLICY_UNREADABLE).toBe(
      "This session's own policy can't be read, so it can't be continued here.",
    );
  });
});

describe("messageAnswer", () => {
  it("is a message for the main agent with no notes", () => {
    expect(messageAnswer("hi")).toEqual({ kind: "message", text: "hi", notes: [], target: "" });
  });
});
