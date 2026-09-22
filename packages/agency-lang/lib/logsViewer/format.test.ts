import { describe, expect, it } from "vitest";

import { fmtTokens, fmtUsd } from "./format.js";

describe("fmtTokens", () => {
  it.each([
    [0, "0"],
    [950, "950"],
    [1500, "1.5k"],
    [14109, "14k"],
    [182547, "183k"],
    [1200000, "1.2M"],
  ])("%d → %s", (count, text) => expect(fmtTokens(count)).toBe(text));
});

describe("fmtUsd", () => {
  it.each([
    [0, ""],
    [0.0015, "$0.0015"],
    [0.018, "$0.018"],
    [1.5, "$1.50"],
  ])("%d → %s", (usd, text) => expect(fmtUsd(usd)).toBe(text));
});
