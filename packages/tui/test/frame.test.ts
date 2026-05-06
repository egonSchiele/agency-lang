import { describe, it, expect } from "vitest";
import { Frame } from "../lib/frame.js";

describe("Frame", () => {
  it("findByKey returns matching child", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 80, height: 24, style: {},
      children: [
        new Frame({ key: "a", x: 0, y: 0, width: 40, height: 24, style: {} }),
        new Frame({ key: "b", x: 40, y: 0, width: 40, height: 24, style: {} }),
      ],
    });
    expect(frame.findByKey("b")).toBeDefined();
    expect(frame.findByKey("b")!.key).toBe("b");
  });

  it("findByKey searches recursively", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 80, height: 24, style: {},
      children: [
        new Frame({
          key: "parent", x: 0, y: 0, width: 80, height: 24, style: {},
          children: [
            new Frame({ key: "nested", x: 0, y: 0, width: 40, height: 12, style: {} }),
          ],
        }),
      ],
    });
    expect(frame.findByKey("nested")).toBeDefined();
  });

  it("findByKey returns undefined for missing key", () => {
    const frame = new Frame({ x: 0, y: 0, width: 80, height: 24, style: {} });
    expect(frame.findByKey("nope")).toBeUndefined();
  });

  it("toPlainText produces text from content cells", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 5, height: 1, style: {},
      content: [[
        { char: "h" }, { char: "e" }, { char: "l" }, { char: "l" }, { char: "o" },
      ]],
    });
    expect(frame.toPlainText()).toContain("hello");
  });

  it("toPlainText works on nested frame with non-zero x/y via findByKey", () => {
    const frame = new Frame({
      x: 0, y: 0, width: 80, height: 24, style: {},
      children: [
        new Frame({
          key: "child", x: 10, y: 5, width: 5, height: 1, style: {},
          content: [[
            { char: "A" }, { char: "B" }, { char: "C" }, { char: " " }, { char: " " },
          ]],
        }),
      ],
    });
    const child = frame.findByKey("child")!;
    expect(child.toPlainText()).toContain("ABC");
  });
});
