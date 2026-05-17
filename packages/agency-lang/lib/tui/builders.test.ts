import { describe, it, expect } from "vitest";
import { line, lines } from "./builders.js";
import { layout } from "./layout.js";

describe("line()", () => {
  it("produces a text element with height: 1", () => {
    const el = line("hi");
    expect(el.type).toBe("text");
    expect(el.content).toBe("hi");
    expect(el.style?.height).toBe(1);
  });

  it("merges caller-provided fg / bg / bold", () => {
    const el = line("hi", { fg: "red", bold: true });
    expect(el.style).toMatchObject({ height: 1, fg: "red", bold: true });
  });

  it("caller-provided height overrides the default", () => {
    const el = line("hi", { height: 2 });
    expect(el.style?.height).toBe(2);
  });
});

describe("lines()", () => {
  it("returns a column of fixed-height rows, justified flex-start", () => {
    const tree = lines(["a", "b", "c"]);
    expect(tree.type).toBe("box");
    expect(tree.style?.flexDirection).toBe("column");
    expect(tree.style?.justifyContent).toBe("flex-start");
    expect(tree.children).toHaveLength(3);
    for (const child of tree.children!) {
      expect(child.style?.height).toBe(1);
    }
  });

  it("places each line one row below the previous one (no stretch)", () => {
    // Sanity: confirm the layout engine does not stretch the column
    // when its children declare height: 1.
    const positioned = layout(lines(["one", "two"]), 80, 24);
    const [a, b] = positioned.children!;
    expect(b.resolvedY - a.resolvedY).toBe(1);
  });
});
