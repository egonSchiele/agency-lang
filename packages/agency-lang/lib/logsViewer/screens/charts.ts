// Chart arithmetic for the overview. Plain strings and numbers in, plain
// strings and numbers out; the screen paints what these return.
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const FULL_CELL = "█";
const SLIVER = "▏";

/** A cell of a stacked column that no band fills. */
export const EMPTY_CELL = -1;

export type ColumnWindow = { from: number; to: number };

/** A horizontal bar of `width` cells using eighth-blocks. */
export function barText(fraction: number, width: number): string {
  const share = Math.max(0, Math.min(1, fraction));
  const cells = share * width;
  const fullCells = Math.floor(cells);
  const eighths = Math.round((cells - fullCells) * EIGHTHS.length);
  const partial = EIGHTHS[Math.min(eighths, EIGHTHS.length - 1)];
  const tooSmallToShow = share > 0 && fullCells === 0 && partial === "";
  const tail = tooSmallToShow ? SLIVER : partial;
  return `${FULL_CELL.repeat(fullCells)}${tail}`.padEnd(width).slice(0, width);
}

/** Top row first. Bands stack from the bottom in the order given. */
export function stackedColumn(values: number[], max: number, height: number): number[] {
  if (max <= 0 || height <= 0) {
    return emptyCells(Math.max(0, height));
  }
  const bandHeights = values.map((value) => Math.round((value / max) * height));
  const stacked = bandHeights.flatMap((rows, band) => Array.from({ length: rows }, () => band));
  const bottomUp = stacked.length > 0 ? stacked.slice(0, height) : sliverFor(values);
  return [...emptyCells(height - bottomUp.length), ...[...bottomUp].reverse()];
}

export function columnWindow(
  count: number,
  room: number,
  focusAt: number | undefined,
): ColumnWindow {
  if (count <= room) {
    return { from: 0, to: count };
  }
  if (focusAt === undefined) {
    return { from: count - room, to: count };
  }
  const centered = focusAt - Math.floor(room / 2);
  const from = Math.max(0, Math.min(centered, count - room));
  return { from, to: from + room };
}

export function ceilingRow(ceiling: number, max: number, height: number): number | undefined {
  if (ceiling > max || max <= 0) {
    return undefined;
  }
  const rowsAboveBottom = Math.round((ceiling / max) * (height - 1));
  return Math.max(0, height - 1 - rowsAboveBottom);
}

function emptyCells(count: number): number[] {
  return Array.from({ length: count }, () => EMPTY_CELL);
}

/** A non-empty column always gets a bottom cell. */
function sliverFor(values: number[]): number[] {
  const band = values.findIndex((value) => value > 0);
  return band === -1 ? [] : [band];
}
