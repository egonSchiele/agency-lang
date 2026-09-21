import { describe, expect, it } from "vitest";

import type { Element } from "./elements.js";
import type { Frame } from "./frame.js";
import { layout } from "./layout.js";
import { flatten } from "./render/flatten.js";
import { render } from "./render/renderer.js";
import { parseStyledText } from "./styleParser.js";
import { CURSOR_BG, TableComponent, clipCell, type TableColumn } from "./table.js";

type Fruit = { name: string; score: string; note: string };

const rows: Fruit[] = [
  { name: "apple", score: "0.90", note: "crisp" },
  { name: "watermelon-very-long", score: "1.00", note: "large" },
];

const columns: TableColumn<Fruit>[] = [
  { key: "name", header: "name", width: 10, cell: (r) => r.name },
  { key: "score", header: "score", width: 7, align: "right", cell: (r) => r.score },
  {
    key: "note",
    header: "note",
    width: "flex",
    cell: (r) => r.note,
    cellStyle: (r) => ({ fg: r.note === "crisp" ? "green" : "gray" }),
  },
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

function drawn(content: string): string {
  return parseStyledText(content)
    .map((span) => span.text)
    .join("");
}

type RenderTableArgs<Row> = Omit<Parameters<TableComponent<Row>["render"]>[0], "cursor" | "width">;

function renderTableFrame<Row>(args: RenderTableArgs<Row>): Frame {
  const width = 40;
  const height = args.rows.length + 1;
  const element = new TableComponent<Row>().render({ ...args, cursor: null, width });
  return render(layout(element, width, height));
}

function renderTable<Row>(args: RenderTableArgs<Row>): string {
  return renderTableFrame(args).toPlainText();
}

function colorAt(frame: Frame, rowIndex: number, columnIndex: number): string | undefined {
  return flatten(frame, frame.width, frame.height)[rowIndex][columnIndex].fg;
}

describe("TableComponent", () => {
  it("pads every cell to its column width so header and rows align", () => {
    const cells = renderCells({ columns, rows, cursor: null, width: 40 });
    const headerName = cells[0];
    const rowName = cells[3];
    expect(drawn(headerName.content)).toBe("name      ");
    expect(drawn(rowName.content)).toBe("apple     ");
    expect(rowName.style.width).toBe(10);
  });

  it("right-aligns right columns, keeping the trailing gap column", () => {
    const cells = renderCells({ columns, rows, cursor: null, width: 40 });
    const score = cells[4];
    expect(drawn(score.content)).toBe("  0.90 ");
  });

  it("flex column absorbs the leftover frame width and reacts to resize", () => {
    const wide = renderCells({ columns, rows, cursor: null, width: 60 });
    const narrow = renderCells({ columns, rows, cursor: null, width: 30 });
    expect(wide[2].style.width).toBe(60 - 10 - 7);
    expect(narrow[2].style.width).toBe(30 - 10 - 7);
  });

  it("clips long cells with an ellipsis, never touching the next column", () => {
    const cells = renderCells({ columns, rows, cursor: null, width: 40 });
    const longName = cells[6];
    expect(drawn(longName.content)).toBe("watermel… ");
    expect(drawn(longName.content).length).toBe(10);
  });

  it("clipCell handles zero and one-cell widths", () => {
    expect(clipCell("anything", 0)).toBe("");
    expect(clipCell("anything", 1)).toBe("…");
    expect(clipCell("ab", 2)).toBe("ab");
  });

  it("sorted header carries the direction arrow with no padding gap", () => {
    const cells = renderCells({
      columns,
      rows,
      cursor: null,
      width: 40,
      sort: { columnKey: "score", direction: "desc" },
    });
    const scoreHeader = cells[1];
    expect(drawn(scoreHeader.content)).toBe("score▼ ");
    expect(scoreHeader.style.fg).toBe("bright-white");
    expect(cells[0].style.fg).toBe("gray");
  });

  it("adjacent headers never touch, even right-aligned next to left-aligned", () => {
    const tight: TableColumn<Fruit>[] = [
      { key: "pass", header: "pass", width: 5, align: "right", cell: () => "✓" },
      { key: "status", header: "status", width: 7, cell: () => "ok" },
    ];
    const cells = textCells(
      new TableComponent<Fruit>().render({ columns: tight, rows, cursor: null, width: 20 }),
    );
    expect(drawn(cells[0].content) + drawn(cells[1].content)).toContain("pass status");
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
      {
        key: "a",
        header: "agent",
        width: 8,
        cell: (r) => r.name,
        headerStyle: () => ({ fg: "bright-cyan" }),
        cellStyle: () => ({ bold: true }),
      },
    ];
    const cells = textCells(
      new TableComponent<Fruit>().render({ columns: styled, rows, cursor: null, width: 20 }),
    );
    expect(cells[0].style.fg).toBe("bright-cyan");
    expect(cells[1].style.bold).toBe(true);
  });

  it("natural columns size to their content when no width is given", () => {
    const natural: TableColumn<Fruit>[] = [
      { key: "n", header: "nm", cell: (r) => r.name },
      { key: "s", header: "score", width: { min: 30 }, cell: (r) => r.score },
    ];
    const cells = textCells(
      new TableComponent<Fruit>().render({ columns: natural, rows, cursor: null, width: 60 }),
    );
    expect(cells[0].style.width).toBe("watermelon-very-long".length + 1);
    expect(cells[1].style.width).toBe(30);
  });

  it("draws a cell whose text looks like a style tag", () => {
    const text = renderTable({
      columns: [{ key: "a", header: "a", cell: (row: { a: string }) => row.a }],
      rows: [{ a: "{bold}" }],
    });
    expect(text).toContain("{bold}");
  });

  it("keeps columns aligned when a cell holds braces", () => {
    const text = renderTable({
      columns: [
        { key: "a", header: "name", cell: (row: { a: string; b: string }) => row.a },
        { key: "b", header: "n", cell: (row: { a: string; b: string }) => row.b },
      ],
      rows: [
        { a: "{}{}", b: "1" },
        { a: "abcd", b: "2" },
      ],
    });
    const [first, second] = text.split("\n").slice(1);
    expect(first.indexOf("1")).toBe(second.indexOf("2"));
  });

  it("a cell can be several colored pieces", () => {
    const frame = renderTableFrame({
      columns: [
        {
          key: "a",
          header: "a",
          cell: () => [
            { text: "round 4 ", style: { fg: "#00ff00" } },
            { text: "grep", style: { fg: "#ffffff" } },
          ],
        },
      ],
      rows: [{}],
    });
    expect(colorAt(frame, 1, 0)).toBe("#00ff00");
    expect(colorAt(frame, 1, 8)).toBe("#ffffff");
  });
});

it("can omit the header and override the cursor background", () => {
  const element = new TableComponent<Fruit>().render({
    columns,
    rows,
    cursor: 0,
    width: 40,
    showHeader: false,
    cursorBg: "#313244",
  });
  const cells = textCells(element);
  expect(cells).toHaveLength(rows.length * columns.length);
  expect(drawn(cells[0].content)).toContain("apple");
  expect(cells[0].style.bg).toBe("#313244");
  expect(element.style?.height).toBe(rows.length);
});
