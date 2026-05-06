import { describe, it, expect } from "vitest";
import { render } from "../lib/render/renderer.js";
import { layout } from "../lib/layout.js";
import { box, text, list, textInput, column, row } from "../lib/builders.js";

function renderElement(element: ReturnType<typeof box>, width = 80, height = 24) {
  const positioned = layout(element, width, height);
  return render(positioned);
}

function contentText(frame: ReturnType<typeof render>): string {
  if (!frame.content) return "";
  return frame.content.map(row => row.map(c => c.char).join("")).join("\n");
}

describe("render", () => {
  it("renders plain text content into cells", () => {
    const frame = renderElement(box({ width: 10, height: 1 }, text("hello")), 80, 24);
    const child = frame.children![0];
    expect(contentText(child)).toContain("hello");
  });

  it("renders a box with border", () => {
    const frame = renderElement(
      box({ width: 10, height: 3, border: true }),
      80, 24,
    );
    // Border should produce content cells with box-drawing chars
    const topRow = frame.content![0];
    expect(topRow[0].char).toBe("┌");
    expect(topRow[9].char).toBe("┐");
    const bottomRow = frame.content![2];
    expect(bottomRow[0].char).toBe("└");
    expect(bottomRow[9].char).toBe("┘");
  });

  it("renders border with label", () => {
    const frame = renderElement(
      box({ width: 20, height: 3, border: true, label: " Test " }),
      80, 24,
    );
    const topRow = frame.content![0];
    const topText = topRow.map(c => c.char).join("");
    expect(topText).toContain(" Test ");
  });

  it("renders styled text with color", () => {
    const frame = renderElement(
      box({ width: 20, height: 1 }, text("{red-fg}hi{/red-fg}")),
      80, 24,
    );
    const child = frame.children![0];
    const hiCells = child.content![0];
    expect(hiCells[0].char).toBe("h");
    expect(hiCells[0].fg).toBe("red");
    expect(hiCells[1].char).toBe("i");
    expect(hiCells[1].fg).toBe("red");
  });

  it("renders a list with selected item highlighted", () => {
    const el = list({ width: 10, height: 3, key: "mylist" }, ["a", "b", "c"], 1);
    const frame = renderElement(el, 80, 24);
    // The selected item (index 1, "b") should have a distinct bg
    const row1 = frame.content![1];
    expect(row1[0].char).toBe("b");
    expect(row1[0].bg).toBeDefined();
  });

  it("renders a textInput with its value", () => {
    const el = textInput({ width: 15, height: 1, key: "input" }, "hello");
    const frame = renderElement(el, 80, 24);
    const text = contentText(frame);
    expect(text).toContain("hello");
  });

  it("handles scrollable content with scrollOffset", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const el = box(
      { width: 20, height: 3, scrollable: true, scrollOffset: 5 },
      text(lines.join("\n")),
    );
    const frame = renderElement(el, 80, 24);
    // Should show lines starting from offset 5
    const child = frame.children![0];
    const visibleText = contentText(child);
    expect(visibleText).toContain("line5");
    expect(visibleText).not.toContain("line0");
  });

  it("recurses into children and produces child frames", () => {
    const el = column(
      box({ key: "top", height: 5 }, text("top")),
      box({ key: "bottom", flex: 1 }, text("bottom")),
    );
    const frame = renderElement(el, 80, 24);
    expect(frame.children).toHaveLength(2);
    expect(frame.children![0].key).toBe("top");
    expect(frame.children![1].key).toBe("bottom");
  });
});
