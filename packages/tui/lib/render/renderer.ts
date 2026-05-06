import type { Cell, PositionedElement } from "../elements.js";
import type { FrameStyle } from "../elements.js";
import { Frame } from "../frame.js";
import { parseStyledText } from "../styleParser.js";

// Box-drawing characters for borders
const BORDER = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
};

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
  const visibleLines = lines.slice(scrollOffset, scrollOffset + innerHeight);
  const grid: Cell[][] = [];

  for (const line of visibleLines) {
    const spans = parseStyledText(line);
    const row: Cell[] = [];
    for (const span of spans) {
      for (const ch of span.text) {
        if (row.length >= innerWidth) break;
        row.push({
          char: ch,
          fg: span.fg ?? fg,
          bg: span.bg ?? bg,
          bold: span.bold ?? bold,
        });
      }
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

function renderListContent(
  items: string[],
  selectedIndex: number | undefined,
  innerWidth: number,
  innerHeight: number,
  fg?: string,
  bg?: string,
): Cell[][] {
  // Auto-scroll to keep selected item visible
  let scrollOffset = 0;
  if (selectedIndex !== undefined && selectedIndex >= innerHeight) {
    scrollOffset = selectedIndex - innerHeight + 1;
  }

  const grid: Cell[][] = [];
  for (let i = 0; i < innerHeight; i++) {
    const itemIdx = i + scrollOffset;
    if (itemIdx >= items.length) {
      grid.push(makeRow(innerWidth, bg));
      continue;
    }

    const isSelected = itemIdx === selectedIndex;
    const itemBg = isSelected ? "blue" : bg;
    const itemFg = isSelected ? "white" : fg;
    const text = items[itemIdx].slice(0, innerWidth);
    const row: Cell[] = [];
    for (const ch of text) {
      row.push({ char: ch, fg: itemFg, bg: itemBg });
    }
    while (row.length < innerWidth) {
      row.push(emptyCell(itemBg));
    }
    grid.push(row);
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
  const borderSize = hasBorder ? 1 : 0;

  const padding = normalizePadding(style.padding);
  const width = positioned.resolvedWidth;
  const height = positioned.resolvedHeight;

  const innerWidth = Math.max(0, width - 2 * borderSize - padding.left - padding.right);
  const innerHeight = Math.max(0, height - 2 * borderSize - padding.top - padding.bottom);

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

  if (positioned.type === "text" && positioned.content !== undefined) {
    const scrollOffset = style.scrollOffset ?? parentScrollOffset;
    innerContent = renderTextContent(
      positioned.content,
      innerWidth,
      innerHeight,
      scrollOffset,
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

  // If there's inner content, blit it into the frame grid
  if (innerContent) {
    if (!content) {
      content = makeGrid(width, height, style.bg);
    }
    const startX = borderSize + padding.left;
    const startY = borderSize + padding.top;
    for (let y = 0; y < innerContent.length && y < innerHeight; y++) {
      for (let x = 0; x < innerContent[y].length && x < innerWidth; x++) {
        content[startY + y][startX + x] = innerContent[y][x];
      }
    }
  }

  // Handle box elements with text content (box wrapping a text child is
  // handled by recursion, but a box can also have direct content)
  if (positioned.type === "box" && positioned.content !== undefined) {
    const boxInner = renderTextContent(
      positioned.content,
      innerWidth,
      innerHeight,
      style.scrollOffset ?? 0,
      style.fg,
      style.bg,
      style.bold,
    );
    if (!content) {
      content = makeGrid(width, height, style.bg);
    }
    const startX = borderSize + padding.left;
    const startY = borderSize + padding.top;
    for (let y = 0; y < boxInner.length && y < innerHeight; y++) {
      for (let x = 0; x < boxInner[y].length && x < innerWidth; x++) {
        content[startY + y][startX + x] = boxInner[y][x];
      }
    }
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

function normalizePadding(padding: undefined | number | { top?: number; bottom?: number; left?: number; right?: number }): { top: number; bottom: number; left: number; right: number } {
  if (padding === undefined) return { top: 0, bottom: 0, left: 0, right: 0 };
  if (typeof padding === "number") return { top: padding, bottom: padding, left: padding, right: padding };
  return {
    top: padding.top ?? 0,
    bottom: padding.bottom ?? 0,
    left: padding.left ?? 0,
    right: padding.right ?? 0,
  };
}
