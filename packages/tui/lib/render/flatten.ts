import type { Cell } from "../elements.js";
import type { Frame } from "../frame.js";

/**
 * Composite a Frame tree into a flat 2D grid of Cells.
 * Recursively blits children on top of parents.
 */
export function flatten(frame: Frame, width: number, height: number): Cell[][] {
  // Initialize grid with spaces
  const grid: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: " " })),
  );

  blitFrame(grid, frame, width, height);
  return grid;
}

function blitFrame(grid: Cell[][], frame: Frame, gridWidth: number, gridHeight: number): void {
  // Blit this frame's content cells
  if (frame.content) {
    for (let y = 0; y < frame.content.length; y++) {
      const gridY = frame.y + y;
      if (gridY < 0 || gridY >= gridHeight) continue;
      const row = frame.content[y];
      for (let x = 0; x < row.length; x++) {
        const gridX = frame.x + x;
        if (gridX < 0 || gridX >= gridWidth) continue;
        grid[gridY][gridX] = row[x];
      }
    }
  }

  // Recursively blit children on top
  if (frame.children) {
    for (const child of frame.children) {
      blitFrame(grid, child, gridWidth, gridHeight);
    }
  }
}
