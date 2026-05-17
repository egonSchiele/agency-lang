import { describe, it, expect } from "vitest";
import { COLOR_NAMES, ansiColors, ansiBgColors, cssColors } from "../colors.js";

describe("COLOR_NAMES", () => {
  it("covers exactly the named ANSI palette", () => {
    expect([...COLOR_NAMES].sort()).toEqual(Object.keys(ansiColors).sort());
  });

  it("covers exactly the named ANSI background palette", () => {
    expect([...COLOR_NAMES].sort()).toEqual(Object.keys(ansiBgColors).sort());
  });

  it("covers exactly the named CSS palette", () => {
    expect([...COLOR_NAMES].sort()).toEqual(Object.keys(cssColors).sort());
  });
});
