import { describe, it, expect } from "vitest";
import { render } from "../render/renderer.js";
import { layout } from "../layout.js";
import { box, text, textInput, column, row } from "../builders.js";

function renderElement(element: ReturnType<typeof box>, width = 80, height = 24) {
  const positioned = layout(element, width, height);
  return render(positioned);
}

function contentText(frame: ReturnType<typeof render>): string {
  if (!frame.content) return "";
  return frame.content.map((row) => row.map((c) => c.char).join("")).join("\n");
}

describe("render", () => {
  it("renders plain text content into cells", () => {
    const frame = renderElement(box({ width: 10, height: 1 }, text("hello")), 80, 24);
    const child = frame.children![0];
    expect(contentText(child)).toContain("hello");
  });

  it("renders a box with border", () => {
    const frame = renderElement(box({ width: 10, height: 3, border: true }), 80, 24);
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
      80,
      24,
    );
    const topRow = frame.content![0];
    const topText = topRow.map((c) => c.char).join("");
    expect(topText).toContain(" Test ");
  });

  it("renders styled text with color", () => {
    const frame = renderElement(box({ width: 20, height: 1 }, text("{red-fg}hi{/red-fg}")), 80, 24);
    const child = frame.children![0];
    const hiCells = child.content![0];
    expect(hiCells[0].char).toBe("h");
    expect(hiCells[0].fg).toBe("red");
    expect(hiCells[1].char).toBe("i");
    expect(hiCells[1].fg).toBe("red");
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

  it("auto-clips overlong text with an ellipsis", () => {
    const frame = renderElement(box({ width: 5, height: 1 }, text("abcdefghij")), 80, 24);
    const child = frame.children![0];
    expect(contentText(child)).toBe("abcd…");
  });

  it("leaves text untouched when it fits", () => {
    const frame = renderElement(box({ width: 10, height: 1 }, text("abc")), 80, 24);
    const child = frame.children![0];
    expect(contentText(child)).toBe("abc       ");
  });

  it("fill style pads empty text cells with the fill character", () => {
    // Empty content + fill: "─" should produce a full-width horizontal rule.
    const el = box({ width: 8, height: 1 }, {
      type: "text",
      content: "",
      style: { fill: "─" },
    } as any);
    const frame = renderElement(el, 80, 24);
    const ruleRow = frame.children![0].content![0].map((c) => c.char).join("");
    expect(ruleRow).toBe("────────");
  });

  it("fill style pads end-of-line cells when content is shorter than width", () => {
    const el = box({ width: 10, height: 1 }, {
      type: "text",
      content: "hi",
      style: { fill: "─" },
    } as any);
    const frame = renderElement(el, 80, 24);
    const row = frame.children![0].content![0].map((c) => c.char).join("");
    expect(row).toBe("hi────────");
  });

  it("textInput renders multi-line value as one visual row per \\n", () => {
    const el = box({ width: 8, height: 3 }, textInput({}, "ab\ncde"));
    const frame = renderElement(el, 80, 24);
    const grid = frame.children![0].content!;
    expect(
      grid[0]
        .slice(0, 2)
        .map((c) => c.char)
        .join(""),
    ).toBe("ab");
    // Cursor sits at end of the last line, not the first.
    expect(grid[0][2].char).toBe(" ");
    expect(
      grid[1]
        .slice(0, 3)
        .map((c) => c.char)
        .join(""),
    ).toBe("cde");
    expect(grid[1][3].char).toBe("█");
  });
});
