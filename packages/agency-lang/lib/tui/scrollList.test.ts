import { describe, it, expect } from "vitest";
import { scrollList } from "./scrollList.js";
import { line } from "./builders.js";

describe("scrollList", () => {
  it("renders only the visible window of items", () => {
    const items = ["a", "b", "c", "d", "e"];
    const { element, scrollTop } = scrollList({
      items,
      cursorIdx: -1,
      scrollTop: 1,
      viewportRows: 2,
      renderItem: (item) => line(item),
    });
    expect(scrollTop).toBe(1);
    expect(element.children).toHaveLength(2);
    expect(element.children![0].content).toBe("b");
    expect(element.children![1].content).toBe("c");
  });

  it("clamps scrollTop when it overshoots the end of the list", () => {
    const { scrollTop } = scrollList({
      items: ["a", "b", "c"],
      cursorIdx: -1,
      scrollTop: 999,
      viewportRows: 2,
      renderItem: (item) => line(item),
    });
    expect(scrollTop).toBe(1); // total 3 - viewport 2 = 1
  });

  it("follows the cursor when it moves out of the viewport", () => {
    const items = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const { scrollTop, element } = scrollList({
      items,
      cursorIdx: 7,
      scrollTop: 0,
      viewportRows: 3,
      renderItem: (item, isCursor) => line(isCursor ? `> ${item}` : `  ${item}`),
    });
    expect(scrollTop).toBe(5); // cursor 7 visible as last row of a 3-row viewport
    expect(element.children).toHaveLength(3);
    expect(element.children![2].content).toBe("> r7");
  });

  it("passes isCursor=true to the renderer for the cursor row", () => {
    const flags: boolean[] = [];
    scrollList({
      items: ["a", "b", "c"],
      cursorIdx: 1,
      scrollTop: 0,
      viewportRows: 3,
      renderItem: (_, isCursor) => {
        flags.push(isCursor);
        return line("x");
      },
    });
    expect(flags).toEqual([false, true, false]);
  });

  it("works with no cursor (cursorIdx = -1) and a short list", () => {
    const { element, scrollTop } = scrollList({
      items: ["only"],
      cursorIdx: -1,
      scrollTop: 0,
      viewportRows: 5,
      renderItem: (item) => line(item),
    });
    expect(scrollTop).toBe(0);
    expect(element.children).toHaveLength(1);
  });

  it("returns an empty column for an empty item list", () => {
    const { element, scrollTop } = scrollList({
      items: [],
      cursorIdx: -1,
      scrollTop: 0,
      viewportRows: 5,
      renderItem: (item: string) => line(item),
    });
    expect(scrollTop).toBe(0);
    expect(element.children ?? []).toHaveLength(0);
  });
});
