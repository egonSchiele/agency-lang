import { describe, it, expect } from "vitest";
import { toHTML } from "../render/html.js";
import { Frame } from "../frame.js";

describe("toHTML", () => {
  it("produces HTML with monospace font", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 5, height: 1, style: {},
      content: [[
        { char: "h" }, { char: "i" }, { char: " " }, { char: " " }, { char: " " },
      ]],
    });
    const html = toHTML(frame);
    expect(html).toContain("monospace");
    expect(html).toContain("hi");
  });

  it("produces colored spans for styled cells", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 2, height: 1, style: {},
      content: [[
        { char: "h", fg: "red" },
        { char: "i", fg: "red" },
      ]],
    });
    const html = toHTML(frame);
    expect(html).toContain("hi");
    // Should have color styling
    expect(html).toContain("color:");
  });

  it("handles bold cells", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 2, height: 1, style: {},
      content: [[
        { char: "h", bold: true },
        { char: "i", bold: true },
      ]],
    });
    const html = toHTML(frame);
    expect(html).toContain("font-weight:bold");
  });

  it("renders nested children", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 10, height: 2, style: {},
      children: [
        new Frame({
          x: 0, y: 0, width: 3, height: 1, style: {},
          content: [[{ char: "A" }, { char: "B" }, { char: "C" }]],
        }),
      ],
    });
    const html = toHTML(frame);
    expect(html).toContain("ABC");
  });
});
