import { describe, it, expect } from "vitest";
import { clampScroll, followCursor } from "./scroll.js";

describe("clampScroll", () => {
  it("keeps a valid scrollTop", () => {
    expect(clampScroll(3, 20, 5)).toBe(3);
  });

  it("clamps when scrollTop exceeds the maximum", () => {
    // 20 rows, viewport 5 → max scrollTop = 15
    expect(clampScroll(99, 20, 5)).toBe(15);
  });

  it("returns 0 when the content fits the viewport", () => {
    expect(clampScroll(99, 3, 10)).toBe(0);
  });

  it("clamps negative values to 0", () => {
    expect(clampScroll(-5, 20, 5)).toBe(0);
  });
});

describe("followCursor", () => {
  it("scrolls up when cursor is above the viewport", () => {
    expect(followCursor(10, 3, 5)).toBe(3);
  });

  it("scrolls down when cursor is below the viewport", () => {
    // scrollTop 0, viewport 5 → visible rows 0..4; cursor at 7 means
    // we need scrollTop = 3 (so 3..7 is visible).
    expect(followCursor(0, 7, 5)).toBe(3);
  });

  it("does nothing when cursor is already visible", () => {
    expect(followCursor(0, 2, 5)).toBe(0);
  });
});
