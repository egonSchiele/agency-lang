import { describe, it, expect } from "vitest";
import { toPlainText } from "../render/plaintext.js";
import { Frame } from "../frame.js";

describe("toPlainText", () => {
  it("renders content cells as text", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 5, height: 1, style: {},
      content: [[
        { char: "h" }, { char: "i" }, { char: " " }, { char: " " }, { char: " " },
      ]],
    });
    expect(toPlainText(frame)).toContain("hi");
  });

  it("renders nested children", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 80, height: 2, style: {},
      children: [
        new Frame({
          key: "a", x: 0, y: 0, width: 5, height: 1, style: {},
          content: [[{ char: "A" }, { char: "B" }, { char: "C" }, { char: " " }, { char: " " }]],
        }),
      ],
    });
    expect(toPlainText(frame)).toContain("ABC");
  });

  it("renders border characters", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 5, height: 3, style: { border: true },
      content: [
        [{ char: "┌" }, { char: "─" }, { char: "─" }, { char: "─" }, { char: "┐" }],
        [{ char: "│" }, { char: " " }, { char: " " }, { char: " " }, { char: "│" }],
        [{ char: "└" }, { char: "─" }, { char: "─" }, { char: "─" }, { char: "┘" }],
      ],
    });
    const text = toPlainText(frame);
    expect(text).toContain("┌───┐");
    expect(text).toContain("└───┘");
  });
});
