import { describe, expect, it } from "vitest";

import { costTone, durationTone, hotMark, THEME, threadColor, toneStyle } from "./theme.js";
import { DEFAULT_THRESHOLDS } from "./thresholds.js";

describe("tones", () => {
  it("a slow duration is hot, a fast one quiet, the rest normal", () => {
    expect(durationTone(6000, DEFAULT_THRESHOLDS)).toBe("hot");
    expect(durationTone(50, DEFAULT_THRESHOLDS)).toBe("quiet");
    expect(durationTone(900, DEFAULT_THRESHOLDS)).toBe("normal");
  });

  it("follows configured thresholds", () => {
    expect(durationTone(900, { slowMs: 500, fastMs: 10, expensiveUsd: 1 })).toBe("hot");
    expect(costTone(0.5, { slowMs: 500, fastMs: 10, expensiveUsd: 1 })).toBe("quiet");
  });

  it("a hot number is marked in text as well as color", () => {
    expect(hotMark("hot")).toBe("!");
    expect(hotMark("normal")).toBe("");
    expect(toneStyle("hot").fg).toBe(THEME.kind.error);
  });
});

describe("threadColor", () => {
  it("cycles instead of running out", () => {
    expect(threadColor(0)).toBe(threadColor(6));
    expect(threadColor(0)).not.toBe(threadColor(1));
  });
});

describe("the palette", () => {
  it("is all six-digit hex, which is what lib/tui emits as truecolor", () => {
    const values = [
      ...Object.values(THEME.kind),
      THEME.chrome,
      THEME.muted,
      THEME.text,
      THEME.accent,
      THEME.cached,
      THEME.ok,
      THEME.rule,
      THEME.cursorBg,
    ];
    for (const value of values) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
