import { describe, it, expect } from "vitest";
import { layout } from "../layout.js";
import { box, row, column, text } from "../builders.js";

describe("layout", () => {
  it("single box fills available space", () => {
    const el = box({ key: "a" });
    const result = layout(el, 80, 24);
    expect(result.resolvedX).toBe(0);
    expect(result.resolvedY).toBe(0);
    expect(result.resolvedWidth).toBe(80);
    expect(result.resolvedHeight).toBe(24);
  });

  it("fixed width and height", () => {
    const el = box({ width: 40, height: 10 });
    const result = layout(el, 80, 24);
    expect(result.resolvedWidth).toBe(40);
    expect(result.resolvedHeight).toBe(10);
  });

  it("percentage width", () => {
    const el = box({ width: "50%" });
    const result = layout(el, 80, 24);
    expect(result.resolvedWidth).toBe(40);
  });

  it("column direction stacks children vertically", () => {
    const el = column(
      box({ key: "a", height: 5 }),
      box({ key: "b", height: 5 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    const b = result.children!.find(c => c.key === "b")!;
    expect(a.resolvedY).toBe(0);
    expect(b.resolvedY).toBe(5);
  });

  it("row direction places children horizontally", () => {
    const el = row(
      box({ key: "a", width: 20 }),
      box({ key: "b", width: 30 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    const b = result.children!.find(c => c.key === "b")!;
    expect(a.resolvedX).toBe(0);
    expect(b.resolvedX).toBe(20);
  });

  it("flex distributes remaining space", () => {
    const el = row(
      box({ key: "a", width: 20 }),
      box({ key: "b", flex: 1 }),
    );
    const result = layout(el, 80, 24);
    const b = result.children!.find(c => c.key === "b")!;
    expect(b.resolvedWidth).toBe(60);
  });

  it("multiple flex children split space proportionally", () => {
    const el = row(
      box({ key: "a", flex: 1 }),
      box({ key: "b", flex: 2 }),
    );
    const result = layout(el, 90, 24);
    const a = result.children!.find(c => c.key === "a")!;
    const b = result.children!.find(c => c.key === "b")!;
    expect(a.resolvedWidth).toBe(30);
    expect(b.resolvedWidth).toBe(60);
  });

  it("border reduces inner space by 2 in each dimension", () => {
    const el = box({ width: 20, height: 10, border: true },
      box({ key: "inner", flex: 1 })
    );
    const result = layout(el, 80, 24);
    const inner = result.children!.find(c => c.key === "inner")!;
    expect(inner.resolvedWidth).toBe(18);
    expect(inner.resolvedHeight).toBe(8);
  });

  it("invisible elements take no space", () => {
    const el = column(
      box({ key: "a", height: 5 }),
      box({ key: "b", height: 5, visible: false }),
      box({ key: "c", height: 5 }),
    );
    const result = layout(el, 80, 24);
    const c = result.children!.find(c => c.key === "c")!;
    expect(c.resolvedY).toBe(5);
  });

  it("nested layout", () => {
    const el = column(
      box({ key: "top", height: "40%" }),
      row({ flex: 1 },
        box({ key: "left", width: "50%" }),
        box({ key: "right", flex: 1 }),
      ),
    );
    const result = layout(el, 100, 20);
    const top = result.children!.find(c => c.key === "top")!;
    expect(top.resolvedHeight).toBe(8);
    const rowEl = result.children![1];
    const left = rowEl.children!.find(c => c.key === "left")!;
    const right = rowEl.children!.find(c => c.key === "right")!;
    expect(left.resolvedWidth).toBe(50);
    expect(right.resolvedWidth).toBe(50);
    expect(left.resolvedY).toBe(8);
  });

  it("padding reduces inner space", () => {
    const el = box({ width: 20, height: 10, padding: 2 },
      box({ key: "inner", flex: 1 })
    );
    const result = layout(el, 80, 24);
    const inner = result.children!.find(c => c.key === "inner")!;
    expect(inner.resolvedWidth).toBe(16);
    expect(inner.resolvedHeight).toBe(6);
  });

  it("margin offsets element position", () => {
    const el = column(
      box({ key: "a", height: 5, margin: { top: 2, left: 3 } }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    expect(a.resolvedX).toBe(3);
    expect(a.resolvedY).toBe(2);
  });

  it("minWidth and minHeight are respected", () => {
    const el = box({ width: 5, height: 3, minWidth: 10, minHeight: 8 });
    const result = layout(el, 80, 24);
    expect(result.resolvedWidth).toBe(10);
    expect(result.resolvedHeight).toBe(8);
  });

  it("maxWidth and maxHeight are respected", () => {
    const el = box({ width: 50, height: 30, maxWidth: 20, maxHeight: 10 });
    const result = layout(el, 80, 40);
    expect(result.resolvedWidth).toBe(20);
    expect(result.resolvedHeight).toBe(10);
  });

  it("percentage height", () => {
    const el = box({ height: "50%" });
    const result = layout(el, 80, 24);
    expect(result.resolvedHeight).toBe(12);
  });

  it("justifyContent flex-end pushes children to end", () => {
    const el = column({ justifyContent: "flex-end" },
      box({ key: "a", height: 5 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    expect(a.resolvedY).toBe(19); // 24 - 5
  });

  it("justifyContent center centers children", () => {
    const el = row({ justifyContent: "center" },
      box({ key: "a", width: 20 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    expect(a.resolvedX).toBe(30); // (80 - 20) / 2
  });

  it("justifyContent space-between distributes gaps", () => {
    const el = row({ justifyContent: "space-between" },
      box({ key: "a", width: 10 }),
      box({ key: "b", width: 10 }),
      box({ key: "c", width: 10 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    const b = result.children!.find(c => c.key === "b")!;
    const c = result.children!.find(c => c.key === "c")!;
    expect(a.resolvedX).toBe(0);
    // gap = floor((80 - 30) / 2) = 25
    expect(b.resolvedX).toBe(35); // 0 + 10 + 25
    expect(c.resolvedX).toBe(70); // 35 + 10 + 25
  });

  it("alignItems center centers children on cross axis", () => {
    const el = row({ alignItems: "center" },
      box({ key: "a", width: 20, height: 10 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    expect(a.resolvedY).toBe(7); // (24 - 10) / 2
    expect(a.resolvedHeight).toBe(10);
  });

  it("alignItems flex-end positions children at cross axis end", () => {
    const el = row({ alignItems: "flex-end" },
      box({ key: "a", width: 20, height: 10 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    expect(a.resolvedY).toBe(14); // 24 - 10
  });

  it("alignItems stretch fills cross axis (default)", () => {
    const el = row(
      box({ key: "a", width: 20 }),
    );
    const result = layout(el, 80, 24);
    const a = result.children!.find(c => c.key === "a")!;
    expect(a.resolvedHeight).toBe(24);
  });
});
