import { describe, it, expect } from "vitest";
import { render } from "../render/renderer.js";
import { layout } from "../layout.js";
import { box, text, list, textInput, column, row } from "../builders.js";

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

  it("follows the tail (no highlight) when selectedIndex == items.length", () => {
    // `repl()` passes `selectedIndex = items.length` to mean
    // "auto-scroll to the most recent item without drawing the
    // selection chrome on any row". Verify the renderer:
    //   1. Shows the last `innerHeight` items (not blank rows)
    //   2. Does not highlight any of them
    const items = ["one", "two", "three", "four", "five"];
    const el = list(
      { width: 10, height: 2, key: "tail" },
      items,
      items.length,
    );
    const frame = renderElement(el, 80, 24);
    expect(frame.content![0][0].char).toBe("f"); // "four"
    expect(frame.content![1][0].char).toBe("f"); // "five"
    // Selected rows would get bg "blue" + fg "white"; following the
    // tail must leave them untouched.
    expect(frame.content![0][0].bg).not.toBe("blue");
    expect(frame.content![1][0].bg).not.toBe("blue");
  });

  it("renders the last item with height 1 when following the tail", () => {
    // The previous behavior set scrollOffset to selectedIndex - height + 1
    // = items.length, which then rendered row[items.length] (past the end)
    // as a blank row. Verify the clamp keeps the last item visible.
    const items = ["a", "b", "c"];
    const el = list({ width: 5, height: 1, key: "tiny" }, items, items.length);
    const frame = renderElement(el, 80, 24);
    expect(frame.content![0][0].char).toBe("c");
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

  it("parses styled-text markup inside list items", () => {
    // Before the fix, list rows ran raw chars into cells so
    // `{red-fg}You{/red-fg}` rendered as the literal markup. After
    // the fix the tag chars are gone and the inner text gets the
    // span's color.
    const items = ["{red-fg}You{/red-fg} hi"];
    // Use follow-tail (selectedIndex == items.length) so the row
    // isn't repainted with selection chrome — we want to inspect
    // the spans' own colors.
    const el = list({ width: 20, height: 1, key: "tx" }, items, items.length);
    const frame = renderElement(el, 80, 24);
    const txt = contentText(frame);
    expect(txt.trim()).toBe("You hi");
    // The "Y" cell should carry the parsed fg color.
    expect(frame.content![0][0].char).toBe("Y");
    expect(frame.content![0][0].fg).toBe("red");
    // The space and "h" cells should NOT carry that color.
    expect(frame.content![0][3].fg).toBeUndefined();
    expect(frame.content![0][4].char).toBe("h");
  });

  it("splits multi-line list items into one visual row per source line", () => {
    // A transcript entry like `highlight("\nreply\n", "markdown")`
    // produces a multi-line string; each `\n`-separated line should
    // get its own row instead of being smashed onto one.
    const items = ["one\ntwo\nthree"];
    const el = list({ width: 10, height: 3, key: "ml" }, items, items.length);
    const frame = renderElement(el, 80, 24);
    expect(frame.content![0].slice(0, 3).map((c) => c.char).join("")).toBe(
      "one",
    );
    expect(frame.content![1].slice(0, 3).map((c) => c.char).join("")).toBe(
      "two",
    );
    expect(frame.content![2].slice(0, 5).map((c) => c.char).join("")).toBe(
      "three",
    );
  });

  it("follow-tail keeps the last visual row of a multi-line item in view", () => {
    // A 3-row tall item followed by selectedIndex = length should
    // show the LAST visual row, not blank rows or the first row.
    const items = ["one\ntwo\nthree", "tail"];
    const el = list({ width: 10, height: 2, key: "ft" }, items, items.length);
    const frame = renderElement(el, 80, 24);
    // visual rows: 0:one 1:two 2:three 3:tail. height 2 → show rows 2 and 3.
    expect(frame.content![0].slice(0, 5).map((c) => c.char).join("")).toBe(
      "three",
    );
    expect(frame.content![1].slice(0, 4).map((c) => c.char).join("")).toBe(
      "tail",
    );
  });
});
