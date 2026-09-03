// Declarative table rendering for TUI apps. A view declares its columns
// (header, width policy, cell text, colors) and hands rows in; the
// component owns width resolution, alignment, ellipsis clipping, header
// sort chrome, and the cursor-row background. Width math is the same
// algorithm std::ui/table uses (lib/utils/columnWidths.ts). Every emitted
// segment carries an explicit width and height — the two lib/tui layout
// rules that otherwise bite (see docs/dev/cli/logs-viewer.md).
import { column, line, row } from "./builders.js";
import type { Element, Style } from "./elements.js";
import { resolveColumnWidths, type ColumnPlan } from "../utils/columnWidths.js";

export const CURSOR_BG = "#3a3a3a";
const HEADER_FG = "gray";
const SORTED_HEADER_FG = "bright-white";
const SORT_ARROWS = { asc: "▲", desc: "▼" } as const;

export type CellStyle = Pick<Style, "fg" | "bg" | "bold" | "dim">;

export type TableColumn<Row> = {
  key: string;
  header: string;
  /** Absent = natural content width. `"flex"` shares the leftover frame
   *  width. `{ min }` = natural with a floor. */
  width?: number | "flex" | { min: number };
  align?: "left" | "right";
  cell: (row: Row) => string;
  headerStyle?: () => CellStyle;
  cellStyle?: (row: Row) => CellStyle;
};

export type TableFrame<Row> = {
  columns: TableColumn<Row>[];
  rows: Row[];
  /** Index into `rows` of the cursor row, or null for no cursor. */
  cursor: number | null;
  sort?: { columnKey: string; direction: "asc" | "desc" };
  width: number;
};

export class TableComponent<Row> {
  render(frame: TableFrame<Row>): Element {
    const widths = this.resolveWidths(frame);
    const header = this.renderHeader(frame, widths);
    const body = frame.rows.map((rowData, index) =>
      this.renderRow(frame, rowData, index === frame.cursor, widths),
    );
    return column({ height: 1 + frame.rows.length, justifyContent: "flex-start" }, header, ...body);
  }

  private resolveWidths(frame: TableFrame<Row>): number[] {
    const plan: ColumnPlan[] = frame.columns.map((column, index) => {
      const natural = this.naturalWidth(column, frame);
      if (typeof column.width === "number") {
        return { index, parsed: { kind: "cells", value: column.width }, natural, minWidth: 0 };
      }
      if (column.width === "flex") {
        return { index, parsed: { kind: "full" }, natural, minWidth: 0 };
      }
      const minWidth = typeof column.width === "object" ? column.width.min : 0;
      return { index, parsed: null, natural, minWidth };
    });
    return resolveColumnWidths(plan, frame.width, "tui table");
  }

  /** Content width plus one trailing space so adjacent columns never
   *  touch. Header labels reserve room for a sort arrow. */
  private naturalWidth(column: TableColumn<Row>, frame: TableFrame<Row>): number {
    const cellWidths = frame.rows.map((rowData) => column.cell(rowData).length);
    return Math.max(column.header.length, ...cellWidths, 0) + 1;
  }

  private renderHeader(frame: TableFrame<Row>, widths: number[]): Element {
    const cells = frame.columns.map((column, index) => {
      const sorted = frame.sort !== undefined && frame.sort.columnKey === column.key;
      const label = sorted
        ? `${column.header}${SORT_ARROWS[frame.sort!.direction]}`
        : column.header;
      const style: CellStyle = column.headerStyle?.() ?? {
        fg: sorted ? SORTED_HEADER_FG : HEADER_FG,
      };
      return segment(label, widths[index], column.align, style);
    });
    return row({ height: 1 }, ...cells);
  }

  private renderRow(
    frame: TableFrame<Row>,
    rowData: Row,
    isCursor: boolean,
    widths: number[],
  ): Element {
    const cells = frame.columns.map((column, index) => {
      const style: CellStyle = { ...column.cellStyle?.(rowData) };
      if (isCursor) {
        style.bg = CURSOR_BG;
      }
      return segment(column.cell(rowData), widths[index], column.align, style);
    });
    return row({ height: 1 }, ...cells);
  }
}

/** Clip to `width` with a trailing ellipsis. Width 0 renders nothing;
 *  width 1 renders just the ellipsis. */
export function clipCell(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, width - 1)}…`;
}

function segment(
  value: string,
  width: number,
  align: "left" | "right" | undefined,
  style: CellStyle,
): Element {
  // The last column of every cell is a guaranteed gap: without it, a
  // full-width value (or a right-aligned one) touches its neighbor and
  // adjacent headers read as one word.
  if (width <= 0) {
    return line("", { width, ...style });
  }
  const inner = width - 1;
  const clipped = clipCell(value, inner);
  const padding = " ".repeat(inner - clipped.length);
  const content = align === "right" ? `${padding}${clipped} ` : `${clipped}${padding} `;
  return line(content, { width, ...style });
}
