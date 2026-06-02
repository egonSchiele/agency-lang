import type { Cell, PositionedElement } from "../elements.js";
import type { FrameStyle } from "../elements.js";
import { Frame } from "../frame.js";
import { parseStyledText } from "../styleParser.js";
import { innerArea } from "../utils.js";

// Box-drawing characters for borders
const BORDER = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
};

function blitCells(dest: Cell[][], src: Cell[][], startX: number, startY: number, maxW: number, maxH: number): void {
  for (let y = 0; y < src.length && y < maxH; y++) {
    for (let x = 0; x < src[y].length && x < maxW; x++) {
      dest[startY + y][startX + x] = src[y][x];
    }
  }
}

function emptyCell(bg?: string): Cell {
  return { char: " ", bg };
}

function makeRow(width: number, bg?: string): Cell[] {
  return Array.from({ length: width }, () => emptyCell(bg));
}

function makeGrid(width: number, height: number, bg?: string): Cell[][] {
  return Array.from({ length: height }, () => makeRow(width, bg));
}

function renderBorder(grid: Cell[][], width: number, height: number, borderColor?: string, label?: string, labelColor?: string): void {
  if (height < 2 || width < 2) return;

  // Top row
  grid[0][0] = { char: BORDER.topLeft, fg: borderColor };
  for (let x = 1; x < width - 1; x++) {
    grid[0][x] = { char: BORDER.horizontal, fg: borderColor };
  }
  grid[0][width - 1] = { char: BORDER.topRight, fg: borderColor };

  // Bottom row
  grid[height - 1][0] = { char: BORDER.bottomLeft, fg: borderColor };
  for (let x = 1; x < width - 1; x++) {
    grid[height - 1][x] = { char: BORDER.horizontal, fg: borderColor };
  }
  grid[height - 1][width - 1] = { char: BORDER.bottomRight, fg: borderColor };

  // Side borders
  for (let y = 1; y < height - 1; y++) {
    grid[y][0] = { char: BORDER.vertical, fg: borderColor };
    grid[y][width - 1] = { char: BORDER.vertical, fg: borderColor };
  }

  // Label on top border
  if (label && width > 2) {
    const maxLabelLen = width - 2;
    const truncated = label.slice(0, maxLabelLen);
    for (let i = 0; i < truncated.length; i++) {
      grid[0][1 + i] = { char: truncated[i], fg: labelColor ?? borderColor };
    }
  }
}

function renderTextContent(
  content: string,
  innerWidth: number,
  innerHeight: number,
  scrollOffset: number,
  fg?: string,
  bg?: string,
  bold?: boolean,
): Cell[][] {
  const lines = content.split("\n");
  // Clamp so that scrolling past the end stops at the last screenful, and
  // negative offsets are treated as 0 (rather than slicing from the tail).
  const maxScroll = Math.max(0, lines.length - innerHeight);
  const effectiveOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const visibleLines = lines.slice(effectiveOffset, effectiveOffset + innerHeight);
  const grid: Cell[][] = [];

  for (const line of visibleLines) {
    const spans = parseStyledText(line);
    const row: Cell[] = [];
    let clipped = false;
    outer: for (const span of spans) {
      for (const ch of span.text) {
        if (row.length >= innerWidth) {
          clipped = true;
          break outer;
        }
        row.push({
          char: ch,
          fg: span.fg ?? fg,
          bg: span.bg ?? bg,
          bold: span.bold ?? bold,
        });
      }
    }
    // If we ran out of room, mark the truncation explicitly with an
    // ellipsis in the final cell. NOTE: widths here are counted by
    // Unicode code points (`for..of` over the string), not grapheme
    // clusters or terminal display cells; combining marks and wide
    // characters (CJK, emoji) can still misalign. Grapheme-aware
    // clipping is out of scope.
    if (clipped && row.length > 0) {
      const last = row[row.length - 1];
      row[row.length - 1] = { ...last, char: "…" };
    }
    // Pad to inner width
    while (row.length < innerWidth) {
      row.push(emptyCell(bg));
    }
    grid.push(row);
  }

  // Pad remaining rows
  while (grid.length < innerHeight) {
    grid.push(makeRow(innerWidth, bg));
  }

  return grid;
}

// Render one item's text into one or more cell rows. Splits the
// item on `\n` so a multi-line transcript entry (e.g. a markdown
// reply) gets its own visual row per source line, parses styled-text
// markup so spans like `{bright-blue-fg}You{/bright-blue-fg}` render
// with color, and applies selection chrome to every produced row.
//
// Returned rows are NOT yet padded to `innerWidth`; the caller pads
// them so selection chrome (`itemBg`) extends across the full row.
function renderListItemRows(
  rawText: string,
  innerWidth: number,
  itemFg: string | undefined,
  itemBg: string | undefined,
): Cell[][] {
  const lines = rawText.split("\n");
  const rows: Cell[][] = [];
  for (const line of lines) {
    const spans = parseStyledText(line);
    const row: Cell[] = [];
    let clipped = false;
    outer: for (const span of spans) {
      for (const ch of span.text) {
        if (row.length >= innerWidth) {
          clipped = true;
          break outer;
        }
        row.push({
          char: ch,
          fg: span.fg ?? itemFg,
          bg: span.bg ?? itemBg,
          bold: span.bold,
        });
      }
    }
    if (clipped && row.length > 0) {
      const last = row[row.length - 1];
      row[row.length - 1] = { ...last, char: "…" };
    }
    rows.push(row);
  }
  return rows;
}

function renderListContent(
  items: string[],
  selectedIndex: number | undefined,
  innerWidth: number,
  innerHeight: number,
  fg?: string,
  bg?: string,
): Cell[][] {
  // Expand each item into one-or-more visual rows up front so
  // auto-scroll can target visual rows (not item indices) — a
  // single long markdown reply might span 10 rows and we still
  // want to keep the latest visual row in view.
  type VisualRow = { itemIdx: number; row: Cell[] };
  const visual: VisualRow[] = [];
  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    // We defer fg/bg selection chrome until we know which itemIdx
    // is selected; for now render with neutral fg/bg and re-tint
    // the cells later if the row's owning item is selected.
    const rows = renderListItemRows(items[itemIdx], innerWidth, fg, bg);
    for (const row of rows) {
      visual.push({ itemIdx, row });
    }
  }

  // `selectedIndex >= items.length` is the "follow tail" sentinel:
  // auto-scroll so the most recent items are visible, but don't
  // draw any selection chrome (no row is actually the cursor). Used
  // by `repl()` to keep the latest transcript line in view as the
  // list grows without highlighting it.
  const followTail =
    selectedIndex !== undefined && selectedIndex >= items.length;

  // Auto-scroll: find the first visual row that belongs to the
  // selected item (or the last visual row in follow-tail mode) and
  // scroll just enough to keep it in the viewport.
  let scrollOffset = 0;
  if (followTail) {
    scrollOffset = Math.max(0, visual.length - innerHeight);
  } else if (selectedIndex !== undefined) {
    // Find the LAST visual row owned by the selected item so multi-
    // line items scroll to reveal their whole body when picked.
    let lastRow = -1;
    for (let i = 0; i < visual.length; i++) {
      if (visual[i].itemIdx === selectedIndex) lastRow = i;
    }
    if (lastRow >= innerHeight) {
      scrollOffset = Math.max(0, lastRow - innerHeight + 1);
    }
  }

  const grid: Cell[][] = [];
  for (let i = 0; i < innerHeight; i++) {
    const visualIdx = i + scrollOffset;
    if (visualIdx >= visual.length) {
      grid.push(makeRow(innerWidth, bg));
      continue;
    }
    const { itemIdx, row } = visual[visualIdx];
    const isSelected = !followTail && itemIdx === selectedIndex;
    const itemBg = isSelected ? "blue" : bg;
    const itemFg = isSelected ? "white" : fg;
    // Re-tint cells for selected rows so the highlight extends
    // across the whole row even when the original spans had their
    // own colors. Untouched rows keep their per-span colors.
    let outRow: Cell[] = row;
    if (isSelected) {
      outRow = row.map((c) => ({ ...c, fg: itemFg, bg: itemBg }));
    }
    while (outRow.length < innerWidth) {
      outRow.push(emptyCell(itemBg));
    }
    grid.push(outRow);
  }

  return grid;
}

function renderTextInputContent(
  value: string | undefined,
  innerWidth: number,
  fg?: string,
  bg?: string,
): Cell[][] {
  const text = (value ?? "").slice(0, innerWidth);
  const row: Cell[] = [];
  for (const ch of text) {
    row.push({ char: ch, fg, bg });
  }
  // Cursor position
  if (row.length < innerWidth) {
    row.push({ char: "█", fg, bg });
  }
  while (row.length < innerWidth) {
    row.push(emptyCell(bg));
  }
  return [row];
}

export function render(positioned: PositionedElement, parentScrollOffset = 0): Frame {
  const style = positioned.style ?? {};
  const hasBorder = style.border ?? false;
  const width = positioned.resolvedWidth;
  const height = positioned.resolvedHeight;

  // Inner area as offsets from the frame's top-left corner.
  const { x: innerOffsetX, y: innerOffsetY, width: innerWidth, height: innerHeight } =
    innerArea(style, 0, 0, width, height);

  const frameStyle: FrameStyle = {
    border: hasBorder || undefined,
    borderColor: style.borderColor,
    bg: style.bg,
    label: style.label,
    labelColor: style.labelColor,
  };

  // Build content cells for this frame
  let content: Cell[][] | undefined;

  if (hasBorder || style.bg) {
    // Start with a full grid for the frame (border + bg fill)
    content = makeGrid(width, height, style.bg);
    if (hasBorder) {
      renderBorder(content, width, height, style.borderColor, style.label, style.labelColor);
    }
  }

  // Render inner content based on element type
  let innerContent: Cell[][] | undefined;
  const effectiveScrollOffset = style.scrollOffset ?? parentScrollOffset;

  if ((positioned.type === "text" || positioned.type === "box") && positioned.content !== undefined) {
    innerContent = renderTextContent(
      positioned.content,
      innerWidth,
      innerHeight,
      effectiveScrollOffset,
      style.fg,
      style.bg,
      style.bold,
    );
  } else if (positioned.type === "list" && positioned.items) {
    innerContent = renderListContent(
      positioned.items,
      positioned.selectedIndex,
      innerWidth,
      innerHeight,
      style.fg,
      style.bg,
    );
  } else if (positioned.type === "textInput") {
    innerContent = renderTextInputContent(
      positioned.value,
      innerWidth,
      style.fg,
      style.bg,
    );
  }

  if (innerContent) {
    if (!content) {
      content = makeGrid(width, height, style.bg);
    }
    blitCells(content, innerContent, innerOffsetX, innerOffsetY, innerWidth, innerHeight);
  }

  // Recurse into children, passing scroll offset if this element is scrollable
  const scrollForChildren = style.scrollable ? (style.scrollOffset ?? 0) : 0;
  const childFrames = ((positioned.children ?? []) as PositionedElement[]).map((child) => render(child, scrollForChildren));

  const frame = new Frame({
    key: positioned.key,
    x: positioned.resolvedX,
    y: positioned.resolvedY,
    width,
    height,
    style: frameStyle,
    content,
    children: childFrames.length > 0 ? childFrames : undefined,
  });

  return frame;
}
