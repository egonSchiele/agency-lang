import { describe, it, expect } from "vitest";
import { describeGuardTrip, parseGuardAnswer } from "./guardAnswer.js";

describe("parseGuardAnswer", () => {
  it("reads a grant, a disarm, a message, and a reject", () => {
    expect(parseGuardAnswer("grant cost 0.5")).toEqual({
      response: { type: "approve", value: { maxCost: 0.5 } },
    });
    expect(parseGuardAnswer("grant time 2m")).toEqual({
      response: { type: "approve", value: { maxTime: 120_000 } },
    });
    expect(parseGuardAnswer("grant time 1500")).toEqual({
      response: { type: "approve", value: { maxTime: 1500 } },
    });
    expect(parseGuardAnswer("disarm cost")).toEqual({
      response: { type: "approve", value: { disarm: ["cost"] } },
    });
    expect(parseGuardAnswer("grant cost $1 message finish up now")).toEqual({
      response: { type: "approve", value: { maxCost: 1, message: "finish up now" } },
    });
    expect(parseGuardAnswer("reject")).toEqual({ response: { type: "reject" } });
  });

  it("refuses an answer the runtime would throw on, with the reason", () => {
    expect(parseGuardAnswer("message keep going")).toMatchObject({
      error: expect.stringContaining("needs a grant or a disarm"),
    });
    expect(parseGuardAnswer("grant cost")).toMatchObject({
      error: expect.stringContaining("amount in dollars"),
    });
    expect(parseGuardAnswer("grant time 2x")).toMatchObject({
      error: expect.stringContaining("such as 30s or 2m"),
    });
    expect(parseGuardAnswer("grant tokens 5")).toMatchObject({
      error: expect.stringContaining("cost or time"),
    });
    expect(parseGuardAnswer("approve")).toMatchObject({
      error: expect.stringContaining("Unknown answer"),
    });
  });
});

describe("describeGuardTrip", () => {
  it("names the guard, the spend against the limit, and the draft", () => {
    expect(
      describeGuardTrip({
        dimension: "cost",
        limit: 0.5,
        spent: 0.75,
        label: "research",
        draftValue: "so far",
      }),
    ).toEqual([
      'Guard "research" tripped on cost: $0.750000 spent of $0.5',
      'Draft a reject returns: "so far"',
    ]);
    expect(
      describeGuardTrip({
        dimension: "time",
        limit: 1000,
        spent: 1234.5,
        label: null,
        draftValue: null,
      }),
    ).toEqual([
      "A guard tripped on time: 1235ms elapsed of 1000ms",
      "No saved draft: a reject returns a failure",
    ]);
  });
});
