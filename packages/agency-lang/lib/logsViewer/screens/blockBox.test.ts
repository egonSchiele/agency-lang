import { describe, expect, it } from "vitest";
import { paint } from "../../tui/paint.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { THEME } from "../theme.js";
import { boxInnerWidth, boxLines, SIDES_MIN_WIDTH } from "./blockBox.js";

const plain = (lines: string[]) =>
  lines.map((line) =>
    parseStyledText(line as never)
      .map((span) => span.text)
      .join(""),
  );
const spec = { title: "USER", stats: "", color: THEME.kind.user, indent: 0, sides: true };

describe("blockBox", () => {
  it("draws the title on the top rule, the stats on the right, and the body between sides", () => {
    const lines = plain(
      boxLines([paint("hello")], 40, { ...spec, stats: "2 lines · 6ms", active: false }),
    );
    expect(lines).toEqual([
      "┌─ USER ────────────── 2 lines · 6ms ──┐",
      "│ hello                                │",
      "└──────────────────────────────────────┘",
    ]);
  });
  it("gives the active box heavy rules and a background on every cell", () => {
    const lines = boxLines([paint("hello", { fg: THEME.text })], 40, { ...spec, active: true });
    expect(plain(lines)[0]).toMatch(/^┏━ USER ━+┓$/);
    expect(plain(lines)[1]).toBe("┃ hello                                ┃");
    for (const span of parseStyledText(lines[1])) {
      expect(span.bg).toBe(THEME.cursorBg);
    }
  });
  it("keeps only the rules in a pane too narrow for sides, and indents by depth", () => {
    const narrow = { ...spec, sides: false, indent: 4, active: false };
    expect(boxInnerWidth(SIDES_MIN_WIDTH - 1, narrow)).toBe(SIDES_MIN_WIDTH - 5);
    const lines = plain(boxLines([paint("hello")], 30, narrow));
    expect(lines).toEqual([
      "    ─ USER ───────────────────",
      "    hello                     ",
      "    ──────────────────────────",
    ]);
  });
});
