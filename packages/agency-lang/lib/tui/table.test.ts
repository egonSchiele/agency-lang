import { describe, expect, it } from "vitest";

import type { Element } from "./elements.js";
import { CURSOR_BG, TableComponent, clipCell, type TableColumn } from "./table.js";

type Fruit = { name: string; score: string; note: string };

const rows: Fruit[] = [
  { name: "apple", score: "0.90", note: "crisp" },
  { name: "watermelon-very-long", score: "1.00", note: "large" },
];

const columns: TableColumn<Fruit>[] = [
  { key: "name", header: "name", width: 10, cell: (r) => r.name },
  { key: "score", header: "score", width: 7, align: "right", cell: (r) => r.score },
  { key: "note", header: "note", width: "flex", cell: (r) => r.note, cellStyle: (r) => ({ fg: r.note === "crisp" ? "green" : "gray" }) },
];

/** All text leaves of an element in render order, with their styles. */
function textCells(el: Element): { content: string; style: Record<string, unknown> }[] {
  if (el.type === "text") {
    return [{ content: el.content ?? "", style: (el.style ?? {}) as Record<string, unknown> }];
  }
  return (el.children ?? []).flatMap(textCells);
}

function renderCells(frame: Parameters<TableComponent<Fruit>["render"]>[0]) {
  return textCells(new TableComponent<Fruit>().render(frame));
}

describe("TableComponent", () => {
  it("pads every cell to its column width so header and rows align", () => {
    const cells = renderCells({ columns, rows, cursor: null, width: 40 });
    const headerName = cells[0];
    const rowName = cells[3];
    expect(headerName.content).toBe("name      ");
    expect(rowName.content).toBe("apple     ");
    expect(rowName.style.width).toBe(10);
  });

  it("right-aligns right columns", () => {
    const cells = renderCells({ columns, rows, cursor: null, width: 40 });
    const score = cells[4];
    expect(score.content).toBe("   0.90");
  });

  it("flex column absorbs the leftover frame width and reacts to resize", () => {
    const wide = renderCells({ columns, rows, cursor: null, width: 60 });
    const narrow = renderCells({ columns, rows, cursor: null, width: 30 });
    expect(wide[2].style.width).toBe(60 - 10 - 7);
    expect(narrow[2].style.width).toBe(30 - 10 - 7);
  });

  it("clips long cells with an ellipsis and never overflows the width", () => {
    const cells = renderCells({ columns, rows, cursor: null, width: 40 });
    const longName = cells[6];
    expect(longName.content).toBe("watermelo…");
    expect(longName.content.length).toBe(10);
  });

  it("clipCell handles zero and one-cell widths", () => {
    expect(clipCell("anything", 0)).toBe("");
    expect(clipCell("anything", 1)).toBe("…");
    expect(clipCell("ab", 2)).toBe("ab");
  });

  it("sorted header carries the direction arrow with no padding gap", () => {
    const cells = renderCells({
      columns, rows, cursor: null, width: 40,
      sort: { columnKey: "score", direction: "desc" },
    });
    const scoreHeader = cells[1];
    expect(scoreHeader.content).toBe(" score▼");
    expect(scoreHeader.style.fg).toBe("bright-white");
    expect(cells[0].style.fg).toBe("gray");
  });

  it("cursor row keeps per-cell foreground and sets the cursor background everywhere", () => {
    const cells = renderCells({ columns, rows, cursor: 0, width: 40 });
    const cursorRowCells = cells.slice(3, 6);
    for (const cell of cursorRowCells) {
      expect(cell.style.bg).toBe(CURSOR_BG);
    }
    expect(cursorRowCells[2].style.fg).toBe("green");
    const otherRow = cells.slice(6, 9);
    expect(otherRow[0].style.bg).toBeUndefined();
  });

  it("headerStyle and cellStyle pass through (identity colors, bold group cells)", () => {
    const styled: TableColumn<Fruit>[] = [
      { key: "a", header: "agent", width: 8, cell: (r) => r.name, headerStyle: () => ({ fg: "bright-cyan" }), cellStyle: () => ({ bold: true }) },
    ];
    const cells = textCells(new TableComponent<Fruit>().render({ columns: styled, rows, cursor: null, width: 20 }));
    expect(cells[0].style.fg).toBe("bright-cyan");
    expect(cells[1].style.bold).toBe(true);
  });

  it("natural columns size to their content when no width is given", () => {
    const natural: TableColumn<Fruit>[] = [
      { key: "n", header: "nm", cell: (r) => r.name },
      { key: "s", header: "score", width: { min: 30 }, cell: (r) => r.score },
    ];
    const cells = textCells(new TableComponent<Fruit>().render({ columns: natural, rows, cursor: null, width: 60 }));
    expect(cells[0].style.width).toBe("watermelon-very-long".length + 1);
    expect(cells[1].style.width).toBe(30);
  });
});
