// std::ui/layout — table renderer.
//
// Pipeline:
//   1. _validateTable          — structural check + cell coercion
//   2. _computeColumnLayouts   — measure each cell, build per-column
//                                 layout (width / align / padding / fg)
//   3. composeTable            — declaratively assemble a section list
//                                 (row blocks interleaved with dividers),
//                                 wrap the lot in the outer frame + caption
//
// `ColumnLayout` is the single source of truth for column geometry
// and style. Anything that needs to know "how wide is column N
// including padding?" or "what's the inner width of the cell grid?"
// derives from it via `_innerTableWidth`. The cell-renderer
// (`_composeRowBlock`) and the divider-renderer (`_composeDividerLine`)
// both consume the same `ColumnLayout[]`, so a change to one stays in
// sync with the other automatically.

import { Style, styledWrapper, visualWidth } from "./ansi.js";
import { Align, Block, above, beside, pad, padLine, styled } from "./block.js";
import {
  BORDER_CELLS, BORDER_CHARS, BorderChars, BorderStyle, buildTopEdge,
  minWidthForTitle, placeTitle, resolveBorderStyle,
} from "./border.js";
import { Cell, ColumnSpec, LayoutNode, Width, parseWidth } from "./nodes.js";
import { growToWidth, renderNode, resolveNode } from "./render.js";
import { NodeHandler, SizingContext, resolveOwnWidth } from "./sizing.js";

export { Cell, ColumnSpec };

// LayoutNode shape — `type: string`, `attrs: non-null object`,
// `children: array`. All three must be own properties so we don't
// accept prototype-chain leakage from `Object.create(...)` etc.
// Without the `attrs` check a malformed object-with-a-type passed by
// an LLM tool call would surface inside a leaf renderer as a generic
// "cannot read property 'content' of undefined" instead of throwing a
// clear `std::ui/layout.table` boundary error.
function _looksLikeLayoutNode(cell: object): boolean {
  if (!Object.hasOwn(cell, "type") || !Object.hasOwn(cell, "attrs") || !Object.hasOwn(cell, "children")) {
    return false;
  }
  const c = cell as { type: unknown; attrs: unknown; children: unknown };
  return (
    typeof c.type === "string" &&
    c.attrs !== null && typeof c.attrs === "object" &&
    Array.isArray(c.children)
  );
}

export function _coerceCell(cell: unknown): LayoutNode {
  if (typeof cell === "string") {
    return { type: "text", attrs: { content: cell }, children: [] };
  }
  if (cell !== null && typeof cell === "object" && _looksLikeLayoutNode(cell)) {
    return cell as LayoutNode;
  }
  throw new Error(
    `std::ui/layout.table: cell must be string or LayoutNode, got ${
      cell === null ? "null" : typeof cell
    }`,
  );
}

export type ValidatedTable = {
  // `header` is `LayoutNode[]` (empty when absent) — not `[] | null` —
  // for symmetry with `body` and `footer`. Callers iterate uniformly
  // without a null guard.
  header: LayoutNode[];
  body:   LayoutNode[][];
  footer: LayoutNode[][];
  columnCount: number;
};

// Structural sanity for a `table` node. An all-empty table (no header
// cells, no body rows, no footer rows) is valid and returns
// `columnCount: 0` — it renders as nothing. Throws on:
//   * any present section whose row length disagrees with the column
//     count (derived from `columns` if set, else `header`, else first
//     body row, else first footer row)
//
// On success returns the three sections with every cell coerced to a
// `LayoutNode`, plus the resolved column count.
export function _validateTable(attrs: Record<string, unknown>): ValidatedTable {
  const rawHeader = attrs.header;
  const rawBody   = attrs.body   ?? [];
  const rawFooter = attrs.footer ?? [];

  if (rawHeader != null && !Array.isArray(rawHeader)) {
    throw new Error(
      `std::ui/layout.table: header must be an array of cells, got ${typeof rawHeader}`,
    );
  }
  const checkSection = (val: unknown, name: string): unknown[][] => {
    if (!Array.isArray(val)) {
      throw new Error(
        `std::ui/layout.table: ${name} must be an array of rows, got ${typeof val}`,
      );
    }
    val.forEach((row, i) => {
      if (!Array.isArray(row)) {
        throw new Error(
          `std::ui/layout.table: ${name} row ${i} must be an array of cells, got ${typeof row}`,
        );
      }
    });
    return val as unknown[][];
  };
  const header = rawHeader as unknown[] | null | undefined;
  const body   = checkSection(rawBody,   "body");
  const footer = checkSection(rawFooter, "footer");

  // An all-empty table is a VALID table that renders as nothing.
  // Table content is routinely model- or tool-derived (an agent
  // rendering a result set), and "no rows" is a legitimate degenerate
  // value there, not a programming error — throwing here crashed the
  // agent CLI mid-display when a tool produced empty output (the
  // 2026-07-23 changelog run). Structural errors — row length
  // mismatches, a zero-cell row alongside real content — still throw
  // below. `columnCount: 0` is the empty marker the sizing and render
  // handlers short-circuit on.
  if ((header ?? []).length === 0 && body.length === 0 && footer.length === 0) {
    return { header: [], body: [], footer: [], columnCount: 0 };
  }

  const rawColumns = attrs.columns;
  if (rawColumns != null && !Array.isArray(rawColumns)) {
    throw new Error(
      `std::ui/layout.table: columns must be an array, got ${typeof rawColumns}`,
    );
  }
  const columns = rawColumns as ColumnSpec[] | null | undefined;
  let columnCount: number;
  if (columns && columns.length > 0) columnCount = columns.length;
  else if (header)                   columnCount = header.length;
  else if (body.length > 0)          columnCount = body[0].length;
  else                                columnCount = footer[0].length;

  if (columnCount === 0) {
    throw new Error(
      "std::ui/layout.table: at least one column is required (header / body / footer / columns must have length > 0)",
    );
  }

  const checkRow = (row: unknown[], label: string) => {
    if (row.length !== columnCount) {
      throw new Error(
        `std::ui/layout.table: ${label} has ${row.length} cells, expected ${columnCount}`,
      );
    }
  };
  if (header) checkRow(header, "header");
  body.forEach(  (r, i) => checkRow(r, `body row ${i}`));
  footer.forEach((r, i) => checkRow(r, `footer row ${i}`));

  return {
    header: header ? header.map(_coerceCell) : [],
    body:   body.map(row   => row.map(_coerceCell)),
    footer: footer.map(row => row.map(_coerceCell)),
    columnCount,
  };
}

type ColumnLayout = {
  width:       number;   // measured content width (after minWidth)
  align:       Align;
  cellPadding: number;
  fgColor:     string;   // "" = none
};

// Inject the column's `fgColor` as the cell's `fgColor` only when the
// cell is a `text` leaf without its own color. Cell-level fg always
// wins; non-text leaves (raw / row / nested containers) are passed
// through untouched.
function _applyColumnFg(c: LayoutNode, colFg: string | undefined): LayoutNode {
  if (!colFg || c.type !== "text") return c;
  if (typeof c.attrs.fgColor === "string" && c.attrs.fgColor !== "") return c;
  return { ...c, attrs: { ...c.attrs, fgColor: colFg } };
}

function _computeColumnLayouts(
  rows: LayoutNode[][],
  columnCount: number,
  columns: ColumnSpec[],
  cellPadding: number,
  resolvedColumnWidths?: number[],
): { layouts: ColumnLayout[]; cellBlocks: Block[][] } {
  const styledRows = rows.map((row) =>
    row.map((cell, c) => _applyColumnFg(cell, columns[c]?.fgColor)),
  );
  const cellBlocks = styledRows.map((row) => row.map(renderNode));
  const layouts: ColumnLayout[] = [];
  for (let c = 0; c < columnCount; c++) {
    const measured = cellBlocks.reduce(
      (m, row) => Math.max(m, row[c].width), 0,
    );
    const spec = columns[c] ?? {};
    const resolved = resolvedColumnWidths?.[c];
    layouts.push({
      width:       resolved ?? Math.max(measured, spec.minWidth ?? 0),
      align:       spec.align ?? "start",
      cellPadding,
      fgColor:     spec.fgColor ?? "",
    });
  }
  return { layouts, cellBlocks };
}

function clampCellPadding(raw: unknown): number {
  const value = (raw as number | undefined) ?? 1;
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 1));
}

export function _tableChromeWidth(
  columnCount: number,
  cellPadding: number,
  columnDividers: boolean,
): number {
  const padding = columnCount * 2 * cellPadding;
  const dividers = columnDividers ? Math.max(0, columnCount - 1) : 0;
  return BORDER_CELLS + padding + dividers;
}

type TableSections = {
  header: LayoutNode[];
  body:   LayoutNode[][];
  footer: LayoutNode[][];
};

export function _resolveTableWidths(
  node: LayoutNode,
  resolvedWidth: number | undefined,
): LayoutNode {
  const attrs = node.attrs;
  const { header, body, footer, columnCount } = _validateTable(attrs);
  // Empty table: nothing to size, no column widths to resolve.
  if (columnCount === 0) {
    return node;
  }
  const columns = (attrs.columns as ColumnSpec[] | null | undefined) ?? [];
  const cellPadding = clampCellPadding(attrs.cellPadding);
  const columnDividers = (attrs.columnDividers as boolean | undefined) ?? true;
  const sections: TableSections = { header, body, footer };
  const chrome = _tableChromeWidth(columnCount, cellPadding, columnDividers);
  const available = resolvedWidth !== undefined ? Math.max(0, resolvedWidth - chrome) : undefined;

  const plan = planColumns(columns, columnCount, sections);
  const resolvedColumnWidths = computeColumnWidths(plan, available);
  const annotated = annotateCellsWithWrap(sections, resolvedColumnWidths);

  return {
    ...node,
    attrs: {
      ...attrs,
      ...(resolvedWidth !== undefined ? { resolvedWidth } : {}),
      resolvedColumnWidths,
      header: attrs.header != null ? annotated.header : attrs.header,
      body: annotated.body,
      footer: annotated.footer,
    },
  };
}

// A single column's sizing inputs, gathered up front so the
// width-distribution logic can read them as data rather than re-deriving
// from the raw `ColumnSpec[]` mid-loop.
type ColumnPlan = {
  index:    number;
  parsed:   Width | null;   // parsed `width` attribute, or null for unsized
  natural:  number;         // measured content width
  minWidth: number;         // explicit floor from `minWidth`
};

function planColumns(
  columns: ColumnSpec[],
  columnCount: number,
  sections: TableSections,
): ColumnPlan[] {
  const natural = measureNaturalColumnWidths(sections, columnCount);
  return Array.from({ length: columnCount }, (_, index) => ({
    index,
    parsed:   parseWidth(columns[index]?.width),
    natural:  natural[index],
    minWidth: columns[index]?.minWidth ?? 0,
  }));
}

// Compute the final width of every column.
//
// Allocation order:
//   1. Fixed-cell columns claim their declared value.
//   2. Unsized columns claim their natural content width.
//   3. Percent / "full" columns share whatever is left of `available`.
//      When their declared percentages sum to > 100, each gets its
//      proportional share of the remainder; otherwise each gets its
//      literal share and the slack stays at the right edge.
//   4. `minWidth` is applied as a floor.
function computeColumnWidths(
  plan: ColumnPlan[],
  available: number | undefined,
): number[] {
  assertPercentsHaveBasis(plan, available);

  const fixed    = plan.map(fixedWidthFor);
  const claimed  = fixed.reduce<number>((sum, w) => sum + (w ?? 0), 0);
  const remain   = Math.max(0, (available ?? Infinity) - claimed);
  const totalPct = sumPercentages(plan);

  return plan.map((col, i) => {
    const own = fixed[i] ?? percentWidthFor(col, remain, totalPct);
    return Math.max(own, col.minWidth);
  });
}

function assertPercentsHaveBasis(plan: ColumnPlan[], available: number | undefined): void {
  if (available !== undefined) return;
  const percentCol = plan.find((col) => isPercentLike(col.parsed));
  if (percentCol === undefined) return;
  throw new Error(
    `std::ui/layout: column[${percentCol.index}] uses a percentage width ` +
    `but the table has no resolved width to take a percentage of. ` +
    `Set width: on the table or one of its ancestors.`,
  );
}

// Width for a column whose own size doesn't depend on the leftover
// space: fixed cells (declared count) or unsized (natural content
// width). Returns null for percent/full columns, which are sized later.
function fixedWidthFor(col: ColumnPlan): number | null {
  if (col.parsed === null)            return col.natural;
  if (col.parsed.kind === "cells")    return col.parsed.value;
  return null;
}

function percentWidthFor(col: ColumnPlan, remaining: number, totalPct: number): number {
  const pct = pctValue(col.parsed);
  const share = totalPct > 100 ? pct / totalPct : pct / 100;
  return Math.floor(remaining * share);
}

function isPercentLike(w: Width | null): boolean {
  return w?.kind === "percent" || w?.kind === "full";
}

function pctValue(w: Width | null): number {
  if (w?.kind === "percent") return w.value;
  if (w?.kind === "full")    return 100;
  return 0;
}

function sumPercentages(plan: ColumnPlan[]): number {
  return plan.reduce((sum, col) => sum + pctValue(col.parsed), 0);
}

function measureNaturalColumnWidths(
  sections: TableSections,
  columnCount: number,
): number[] {
  const rows = [
    ...(sections.header.length > 0 ? [sections.header] : []),
    ...sections.body,
    ...sections.footer,
  ];
  return Array.from({ length: columnCount }, (_, c) =>
    rows.reduce((max, row) => Math.max(max, renderNode(row[c]).width), 0),
  );
}

function annotateCellsWithWrap(
  sections: TableSections,
  resolvedColumnWidths: number[],
): TableSections {
  const annotateCell = (cell: LayoutNode, columnWidth: number): LayoutNode => {
    if (cell.type === "text") return { ...cell, attrs: { ...cell.attrs, wrapWidth: columnWidth } };
    if (cell.type === "raw")  return cell;
    return resolveNode(cell, { defaultWidth: columnWidth, percentBasis: columnWidth });
  };
  const annotateRow = (row: LayoutNode[]): LayoutNode[] =>
    row.map((cell, c) => annotateCell(cell, resolvedColumnWidths[c] ?? 0));
  return {
    header: annotateRow(sections.header),
    body:   sections.body.map(annotateRow),
    footer: sections.footer.map(annotateRow),
  };
}

function _innerTableWidth(layouts: ColumnLayout[], columnDividers: boolean): number {
  const cellsW = layouts.reduce((s, l) => s + l.width + 2 * l.cellPadding, 0);
  return cellsW + (columnDividers ? Math.max(0, layouts.length - 1) : 0);
}

// Pad a cell to its column's content width with the column's
// horizontal alignment, then add `cellPadding` spaces on each side.
// The two-step pad keeps alignment relative to the *content* width
// (not the padded width), so `align: "end"` still right-edges at the
// column boundary, not at the outer cellPadding edge.
function _layoutCell(block: Block, layout: ColumnLayout, rowHeight: number): Block {
  const aligned = pad(block, layout.width, rowHeight, layout.align, "start");
  if (layout.cellPadding <= 0) return aligned;
  const padStr = " ".repeat(layout.cellPadding);
  return Block.of(aligned.lines.map((l) => padStr + l + padStr));
}

// Build a single row block (cells joined, no outer side borders).
function _composeRowBlock(
  cells: Block[],
  layouts: ColumnLayout[],
  columnDividers: boolean,
  dividerChar: string,
  wrapBorder: (s: string) => string,
): Block {
  const rowHeight   = cells.reduce((m, b) => Math.max(m, b.height), 1);
  const paddedCells = cells.map((b, c) => _layoutCell(b, layouts[c], rowHeight));
  if (!columnDividers || paddedCells.length <= 1) {
    return paddedCells.reduce(beside, Block.empty());
  }
  const dividerBlock = Block.of(Array(rowHeight).fill(wrapBorder(dividerChar)));
  return paddedCells.reduce<Block>(
    (acc, cell, i) =>
      i === 0 ? cell : beside(beside(acc, dividerBlock), cell),
    Block.empty(),
  );
}

// Build a horizontal section divider with the proper junction
// characters: `├` and `┤` on the side borders, `┼` at every column
// crossing. When `innerWidth` exceeds the natural cell grid (e.g.
// because a wide title widened the table), the extra width is filled
// with plain `h` chars on the right.
function _composeDividerLine(
  layouts: ColumnLayout[],
  columnDividers: boolean,
  innerWidth: number,
  ch: BorderChars,
  wrapBorder: (s: string) => string,
): Block {
  const runs    = layouts.map((l) => ch.h.repeat(l.width + 2 * l.cellPadding));
  const inner   = columnDividers ? runs.join(ch.cross) : runs.join("");
  const padding = ch.h.repeat(Math.max(0, innerWidth - visualWidth(inner)));
  return Block.of(wrapBorder(ch.leftTee + inner + padding + ch.rightTee));
}

// Tags that act as explicit opt-outs of header auto-bold. Agency's
// `text()` constructor always serializes `bold: false` by default, so
// treating `bold === false` as "set" would mean no `text()` cell ever
// got the auto-bold — only bare strings would. We only treat
// `bold === true` as a "do not touch" signal; any other explicit
// modifier on the leaf (italic / dim / underline / fgColor / bgColor)
// also opts out — the caller's styling wins.
function _hasExplicitTextStyle(attrs: Record<string, unknown>): boolean {
  return attrs.bold === true
      || attrs.italic === true
      || attrs.dim === true
      || attrs.underline === true
      || (typeof attrs.fgColor === "string" && attrs.fgColor !== "")
      || (typeof attrs.bgColor === "string" && attrs.bgColor !== "");
}

function _styleHeaderCell(c: LayoutNode): LayoutNode {
  // Only auto-bold `text` cells with no explicit modifier.
  // Pre-built nodes (`raw`, `row`) and `text` with any explicit style
  // modifier are passed through verbatim — the caller's styling wins.
  if (c.type !== "text") return c;
  if (_hasExplicitTextStyle(c.attrs)) return c;
  return { ...c, attrs: { ...c.attrs, bold: true } };
}

// Wrap a row block's lines with the outer `│` side borders, padding
// to `innerWidth` so the right edge lines up with the rest of the
// table.
function _wrapRowSides(
  rowBlock: Block,
  innerWidth: number,
  ch: BorderChars,
  wrapBorder: (s: string) => string,
): Block {
  const side = wrapBorder(ch.v);
  return Block.of(
    rowBlock.lines.map((l) => side + padLine(l, innerWidth, "start") + side),
  );
}

// Declarative interleave of `row` and `divider` markers for one
// section. Returns an empty array if `rows` is empty (so the caller
// can simply concat the three sections without separator guards).
type SectionPart = { kind: "row"; cells: Block[] } | { kind: "divider" };

function _interleaveRows(
  rows: Block[][],
  rowDividers: boolean,
): SectionPart[] {
  return rows.flatMap((cells, i): SectionPart[] => {
    const row: SectionPart = { kind: "row", cells };
    if (rowDividers && i < rows.length - 1) {
      return [row, { kind: "divider" }];
    }
    return [row];
  });
}

// Glue header / body / footer into a single section list, inserting
// header- and footer-dividers only where there is something on both
// sides to separate.
function _buildSectionParts(
  header: Block[][],
  body:   Block[][],
  footer: Block[][],
  opts: { headerDivider: boolean; footerDivider: boolean; rowDividers: boolean },
): SectionPart[] {
  // `rowDividers` is documented as drawing a divider between every
  // *body* row — header and footer are always treated as single blocks
  // (multi-row footers like `["", "Total", "50"]` + `["", "VAT", "10"]`
  // should sit flush, not get carved up).
  const sections: SectionPart[][] = [
    _interleaveRows(header, false),
    _interleaveRows(body,   opts.rowDividers),
    _interleaveRows(footer, false),
  ];
  const useHeaderDivider = opts.headerDivider && header.length > 0 && (body.length + footer.length) > 0;
  const useFooterDivider = opts.footerDivider && footer.length > 0 && body.length > 0;

  const separators: (SectionPart[] | null)[] = [
    null,
    useHeaderDivider ? [{ kind: "divider" }] : null,
    useFooterDivider ? [{ kind: "divider" }] : null,
  ];
  return sections.flatMap((parts, i) => [...(separators[i] ?? []), ...parts]);
}

// Centered, dim caption row. Returns null when no caption is set.
// The returned block has its trailing whitespace trimmed; the caller
// must NOT pass it through `above` (which would re-pad it back out
// to the table width). Append the lines directly instead.
function _composeCaption(caption: string, width: number): Block | null {
  if (caption === "") return null;
  const centered = padLine(caption, width, "center").trimEnd();
  return styled(Block.of(centered), { dim: true });
}

export function composeTable(node: LayoutNode): Block {
  const { header, body, footer, columnCount } = _validateTable(node.attrs);
  // Empty table renders as nothing — no frame, no lines.
  if (columnCount === 0) {
    return Block.empty();
  }
  const attrs = node.attrs;
  // Clamp to a non-negative integer. `_innerTableWidth` and the
  // divider line both use `cellPadding` in width arithmetic; a
  // negative value would shrink dividers below the cell grid and
  // misalign the right border, while a fractional value would break
  // `" ".repeat(...)`.
  const cellPadding    = clampCellPadding(attrs.cellPadding);
  const columns        = (attrs.columns        as ColumnSpec[] | null) ?? [];
  const columnDividers = (attrs.columnDividers as boolean) ?? true;
  const headerDivider  = (attrs.headerDivider  as boolean) ?? true;
  const footerDivider  = (attrs.footerDivider  as boolean) ?? true;
  const rowDividers    = (attrs.rowDividers    as boolean) ?? false;
  const borderStyleKey = resolveBorderStyle(
    (attrs.borderStyle as string | undefined) ?? "rounded",
  );
  const ch          = BORDER_CHARS[borderStyleKey];
  const borderColor = (attrs.borderColor as string | undefined) ?? "";
  const titleColor  = (attrs.titleColor  as string | undefined) ?? "";
  const title       = (attrs.title       as string | undefined) ?? "";
  const caption     = (attrs.caption     as string | undefined) ?? "";
  const resolved    = attrs.resolvedWidth as number | undefined;
  const resolvedColumnWidths = attrs.resolvedColumnWidths as number[] | undefined;
  const wrapBorder  = styledWrapper(borderColor ? { fgColor: borderColor } : {});
  const titleStyle: Style = titleColor ? { fgColor: titleColor } : {};

  // Apply default-bold to header text cells before measurement so the
  // bold SGR (zero visual width) doesn't perturb column sizing.
  const styledHeader = header.map(_styleHeaderCell);

  // Single measure pass over every row so columns line up across
  // sections. We then slice rendered cells back into sections in the
  // same order we assembled them.
  const allRows: LayoutNode[][] = [
    ...(styledHeader.length > 0 ? [styledHeader] : []),
    ...body,
    ...footer,
  ];
  const { layouts, cellBlocks } = _computeColumnLayouts(
    allRows, columnCount, columns, cellPadding, resolvedColumnWidths,
  );
  let idx = 0;
  const headerCells = styledHeader.length > 0 ? [cellBlocks[idx++]] : [];
  const bodyCells   = body.map(()   => cellBlocks[idx++]);
  const footerCells = footer.map(() => cellBlocks[idx++]);

  // A wide title may grow innerWidth beyond the cell grid; dividers and
  // row wrappers both honour that final width so everything lines up.
  const cellsWidth    = _innerTableWidth(layouts, columnDividers);
  const titleFloor    = resolved === undefined && title !== "" ? minWidthForTitle(title) : 0;
  const resolvedInner = resolved !== undefined ? Math.max(0, resolved - BORDER_CELLS) : 0;
  const innerWidth    = Math.max(cellsWidth, titleFloor, resolvedInner);

  // Build flat declarative list of section parts, then render each
  // part into a Block in one place.
  const sectionParts = _buildSectionParts(
    headerCells, bodyCells, footerCells,
    { headerDivider, footerDivider, rowDividers },
  );
  const renderPart = (part: SectionPart): Block =>
    part.kind === "divider"
      ? _composeDividerLine(layouts, columnDividers, innerWidth, ch, wrapBorder)
      : _wrapRowSides(
          _composeRowBlock(part.cells, layouts, columnDividers, ch.v, wrapBorder),
          innerWidth, ch, wrapBorder,
        );
  // A title that doesn't fit on the top edge gets wrapped inside the
  // frame as its own section. Same rule the box renderer uses (via
  // `placeTitle` in border.ts) — but only when the table has a resolved
  // width; otherwise the table is free to grow to fit the title.
  const placement = resolved === undefined
    ? { kind: "top" as const, title }
    : placeTitle(title, innerWidth, titleStyle);
  const titleRows = placement.kind === "wrapped"
    ? [_wrapRowSides(placement.block, innerWidth, ch, wrapBorder)]
    : [];
  const topTitle = placement.kind === "top" ? placement.title : "";
  const sectionBlocks = [...titleRows, ...sectionParts.map(renderPart)];

  // Outer frame (top + bottom edges).
  const topEdge    = Block.of(
    buildTopEdge(ch, innerWidth, wrapBorder, topTitle, titleStyle),
  );
  const bottomEdge = Block.of(
    wrapBorder(ch.bl + ch.h.repeat(innerWidth) + ch.br),
  );
  const framed = [topEdge, ...sectionBlocks, bottomEdge]
    .reduce(above, Block.empty());

  // Optional caption below. Append directly via Block construction
  // (not `above`) — `_composeCaption` returns a trimmed-trailing-space
  // line, and routing it through `above` would re-pad it back out to
  // the framed width.
  const captionBlock = _composeCaption(caption, framed.width);
  const withCaption = captionBlock === null
    ? framed
    : Block.of([...framed.lines, ...captionBlock.lines]);
  return resolved !== undefined ? growToWidth(withCaption, resolved) : withCaption;
}

function sizeTable(node: LayoutNode, ctx: SizingContext): LayoutNode {
  // Tables have a custom column-width distribution; delegate to the
  // table module after resolving the table's own outer width.
  return _resolveTableWidths(node, resolveOwnWidth(node, ctx));
}

export const table: NodeHandler = { size: sizeTable, render: composeTable };
