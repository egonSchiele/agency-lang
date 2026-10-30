import { describe, it, expect } from "vitest";
import {
  DEFAULT_ROUND_WARNING,
  fillRoundWarning,
  roundWarningDue,
  roundWarningSettings,
  type RoundWarningSettings,
} from "./roundWarning.js";

const none = { first: false, final: false };

/** The kind due at the boundary after `round`, or null. */
function kindAt(settings: RoundWarningSettings, round: number, limit: number, fired = none) {
  return roundWarningDue(settings, round, limit, fired)?.kind ?? null;
}

describe("roundWarningSettings", () => {
  it("is the defaults when nothing is set", () => {
    expect(roundWarningSettings(undefined, undefined)).toEqual(DEFAULT_ROUND_WARNING);
    expect(roundWarningSettings(null, null)).toEqual(DEFAULT_ROUND_WARNING);
  });

  it("merges the call's value over the branch default field by field", () => {
    const settings = roundWarningSettings({ text: "x" }, { remaining: 5 });
    expect(settings.remaining).toBe(5);
    expect(settings.text).toBe("x");
    expect(settings.finalWarning).toBe(true);
    expect(settings.finalWarningText).toBe(DEFAULT_ROUND_WARNING.finalWarningText);
  });
});

describe("fillRoundWarning", () => {
  it("fills both placeholders", () => {
    expect(fillRoundWarning("{remaining} of {limit}", { remaining: 2, limit: 9 })).toBe("2 of 9");
  });

  it("leaves an unknown placeholder as written", () => {
    expect(fillRoundWarning("{foo} {remaining}", { remaining: 2, limit: 9 })).toBe("{foo} 2");
  });
});

describe("roundWarningDue", () => {
  const defaults = DEFAULT_ROUND_WARNING;

  it("with a cap of 50, warns at 3 left and at 1 left, once each", () => {
    expect(kindAt(defaults, 40, 50)).toBeNull();
    const first = roundWarningDue(defaults, 46, 50, none);
    expect(first?.kind).toBe("first");
    expect(first?.text).toContain("Of the 50 tool rounds for this request, 3 remain.");
    expect(kindAt(defaults, 47, 50, { first: true, final: false })).toBeNull();
    const final = roundWarningDue(defaults, 48, 50, { first: true, final: false });
    expect(final?.kind).toBe("final");
    expect(final?.text).toBe(defaults.finalWarningText);
    expect(kindAt(defaults, 49, 50, { first: true, final: true })).toBeNull();
  });

  it("with a cap of 10, warns after rounds 6 and 8", () => {
    expect(kindAt(defaults, 5, 10)).toBeNull();
    expect(kindAt(defaults, 6, 10)).toBe("first");
    expect(kindAt(defaults, 8, 10, { first: true, final: false })).toBe("final");
  });

  it("with a cap of 2, sends only the final warning, after round 0", () => {
    expect(kindAt(defaults, 0, 2)).toBe("final");
    expect(kindAt(defaults, 1, 2, { first: false, final: true })).toBeNull();
  });

  it("with a threshold of 1, sends only the final warning", () => {
    const settings = { ...defaults, remaining: 1 };
    expect([0, 1, 2, 3].map((round) => kindAt(settings, round, 5))).toEqual([
      null,
      null,
      null,
      "final",
    ]);
  });

  it("with a threshold of 0, sends no first warning", () => {
    const settings = { ...defaults, remaining: 0 };
    expect([0, 1, 2].map((round) => kindAt(settings, round, 5))).toEqual([null, null, null]);
    expect(kindAt(settings, 3, 5)).toBe("final");
  });

  it("with finalWarning off, sends no final warning", () => {
    const settings = { ...defaults, finalWarning: false };
    expect(kindAt(settings, 3, 5, { first: true, final: false })).toBeNull();
  });

  it("with a threshold above the cap, warns at the first boundary", () => {
    const due = roundWarningDue({ ...defaults, remaining: 10 }, 0, 3, none);
    expect(due?.kind).toBe("first");
    expect(due?.text).toContain("2 remain");
  });
});
