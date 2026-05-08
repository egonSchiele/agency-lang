import { describe, it, expect } from "vitest";
import { box, row, column, text, list, textInput } from "../builders.js";

describe("builders", () => {
  it("text() creates a text element", () => {
    const el = text("hello");
    expect(el).toEqual({ type: "text", content: "hello" });
  });

  it("box() with style and children", () => {
    const el = box({ border: true, key: "mybox" }, text("hi"));
    expect(el.type).toBe("box");
    expect(el.key).toBe("mybox");
    expect(el.style?.border).toBe(true);
    expect(el.children).toHaveLength(1);
    expect(el.children![0].content).toBe("hi");
  });

  it("box() without style treats all args as children", () => {
    const el = box(text("a"), text("b"));
    expect(el.type).toBe("box");
    expect(el.style).toBeUndefined();
    expect(el.children).toHaveLength(2);
  });

  it("row() sets flexDirection to row", () => {
    const el = row({ flex: 1 }, text("a"));
    expect(el.style?.flexDirection).toBe("row");
  });

  it("column() sets flexDirection to column", () => {
    const el = column({ flex: 1 }, text("a"));
    expect(el.style?.flexDirection).toBe("column");
  });

  it("list() creates a list element", () => {
    const el = list({ key: "mylist" }, ["a", "b", "c"], 1);
    expect(el.type).toBe("list");
    expect(el.items).toEqual(["a", "b", "c"]);
    expect(el.selectedIndex).toBe(1);
  });

  it("textInput() creates a textInput element", () => {
    const el = textInput({ key: "input" }, "hello");
    expect(el.type).toBe("textInput");
    expect(el.value).toBe("hello");
  });
});
