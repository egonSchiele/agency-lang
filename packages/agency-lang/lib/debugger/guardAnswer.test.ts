import { describe, it, expect } from "vitest";
import {
  checkGrant,
  describeGuardTrip,
  draftNote,
  guardChoices,
  guardResponse,
  parseAmount,
  type GuardTripData,
} from "./guardAnswer.js";

const costTrip: GuardTripData = {
  dimension: "cost",
  limit: 0.5,
  spent: 0.75,
  label: "research",
  draftValue: "so far",
};
const timeTrip: GuardTripData = {
  dimension: "time",
  limit: 1000,
  spent: 1234.5,
  label: null,
  draftValue: null,
};

describe("the guard trip form's pieces", () => {
  it("describes the trip and the draft", () => {
    expect(describeGuardTrip(costTrip)).toBe(
      'Guard "research" tripped on cost: $0.75 spent of $0.5',
    );
    expect(describeGuardTrip(timeTrip)).toBe("A guard tripped on time: 1235ms spent of 1000ms");
    expect(draftNote(costTrip)).toBe('A reject may return the saved draft: "so far"');
    expect(draftNote(timeTrip)).toContain("No saved draft");
  });

  it("names the choices for the tripped dimension", () => {
    expect(guardChoices(timeTrip).map((c) => c.label)).toEqual([
      "Approve with more budget",
      "Remove the time limit",
      "Reject",
    ]);
  });

  it("reads an amount in the dimension's unit", () => {
    expect(parseAmount("cost", "$0.5")).toBe(0.5);
    expect(parseAmount("cost", "abc")).toBeNull();
    expect(parseAmount("time", "2m")).toBe(120_000);
    expect(parseAmount("time", "1500")).toBe(1500);
    expect(parseAmount("time", "2x")).toBeNull();
  });

  it("refuses a grant that leaves the budget exceeded, as the runtime would", () => {
    expect(checkGrant(costTrip, 0.1)).toContain("must be more than $0.25");
    expect(checkGrant(costTrip, 0.3)).toBeNull();
    expect(checkGrant(timeTrip, 100)).toContain("must be more than 235ms");
  });

  it("builds the response the runtime understands", () => {
    expect(guardResponse(costTrip, "grant", 1, " finish up ")).toEqual({
      type: "approve",
      value: { maxCost: 1, message: "finish up" },
    });
    expect(guardResponse(timeTrip, "grant", 5000, "")).toEqual({
      type: "approve",
      value: { maxTime: 5000 },
    });
    expect(guardResponse(costTrip, "removeLimit", null, "")).toEqual({
      type: "approve",
      value: { disarm: ["cost"] },
    });
    expect(guardResponse(costTrip, "reject", null, "")).toEqual({ type: "reject" });
  });
});
