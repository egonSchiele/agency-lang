import type { Cell } from "../elements.js";
import type { Frame } from "../frame.js";

/**
 * Composite a Frame tree into a flat 2D grid of Cells.
 * Recursively blits children on top of parents.
 * Uses the frame's own x/y as the origin so sub-frames
 * returned by findByKey() render correctly.
 *
 * Result is memoized on the frame instance via `getFlattened()` when
 * called with the frame's own dimensions, since rendering and the three
 * adapters all flatten the same frame at its native size.
 */
export function flatten(frame: Frame, width: number, height: number): Cell[][] {
  if (width === frame.width && height === frame.height) {
    return frame.getFlattened(() => buildGrid(frame, width, height));
  }
  return buildGrid(frame, width, height);
}

function buildGrid(frame: Frame, width: number, height: number): Cell[][] {
  const grid: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: " " })),
  );

  blitFrame(grid, frame, width, height, frame.x, frame.y);
  return grid;
}

function blitFrame(grid: Cell[][], frame: Frame, gridWidth: number, gridHeight: number, originX: number, originY: number): void {
  if (frame.content) {
    for (let y = 0; y < frame.content.length; y++) {
      const gridY = frame.y - originY + y;
      if (gridY < 0 || gridY >= gridHeight) continue;
      const row = frame.content[y];
      for (let x = 0; x < row.length; x++) {
        const gridX = frame.x - originX + x;
        if (gridX < 0 || gridX >= gridWidth) continue;
        grid[gridY][gridX] = row[x];
      }
    }
  }

  if (frame.children) {
    for (const child of frame.children) {
      blitFrame(grid, child, gridWidth, gridHeight, originX, originY);
    }
  }
}
