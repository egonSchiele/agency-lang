import type { Frame } from "../frame.js";
import type { OutputTarget } from "./types.js";
import type { Cell } from "../elements.js";
import { cellsToANSI, gridToANSI } from "../render/ansi.js";
import { flatten } from "../render/flatten.js";
import { sameStyle } from "../utils.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";
// Synchronized output (BSU/ESU, DCS 2026): tells supporting
// terminals to buffer drawing operations between BSU and ESU and
// apply them atomically. Eliminates the cell-by-cell repaint flicker
// otherwise visible during a full-screen render. Terminals without
// support (older xterm etc.) silently ignore the sequences.
// Spec: https://gist.github.com/christianparpart/d8a62cc1ab659194337d73e399004036
const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

type TerminalOutputOptions = {
  synchronizedOutput?: boolean;
};

function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.char === b.char && sameStyle(a, b);
}

function sameGridSize(a: Cell[][], b: Cell[][]): boolean {
  return a.length === b.length && a.every((row, idx) => row.length === b[idx].length);
}

function diffToANSI(prev: Cell[][], next: Cell[][]): string {
  const parts: string[] = [];

  for (let y = 0; y < next.length; y++) {
    const prevRow = prev[y];
    const nextRow = next[y];
    let x = 0;
    while (x < nextRow.length) {
      if (sameCell(prevRow[x], nextRow[x])) {
        x++;
        continue;
      }

      const start = x;
      const cells: Cell[] = [];
      while (x < nextRow.length && !sameCell(prevRow[x], nextRow[x])) {
        cells.push(nextRow[x]);
        x++;
      }
      parts.push(moveTo(y + 1, start + 1), cellsToANSI(cells));
    }
  }

  return parts.join("");
}

export class TerminalOutput implements OutputTarget {
  private inAltScreen = false;
  private previousGrid: Cell[][] | null = null;
  private synchronizedOutput: boolean;
  // Tracks whether our SIGTSTP listener is currently installed. We
  // remove it during the suspend handoff and re-install it on resume,
  // and SIGCONT can be delivered independently of our SIGTSTP path
  // (e.g. from a foreign SIGSTOP), so the resume path must be idempotent.
  private sigtstpInstalled = false;
  private exitHandler = () => this.destroy();
  private sigintHandler = () => { this.destroy(); process.exit(130); };
  private sigtermHandler = () => { this.destroy(); process.exit(143); };
  private sigtstpHandler = () => {
    // Remove our handler before re-raising so the default handler can
    // actually suspend the process; otherwise we'd recurse into ourselves.
    this.suspend();
    if (this.sigtstpInstalled) {
      process.removeListener("SIGTSTP", this.sigtstpHandler);
      this.sigtstpInstalled = false;
    }
    process.kill(process.pid, "SIGTSTP");
  };
  private sigcontHandler = () => {
    this.resume();
    // Re-install only if we don't currently have it registered.
    if (!this.sigtstpInstalled) {
      process.on("SIGTSTP", this.sigtstpHandler);
      this.sigtstpInstalled = true;
    }
  };

  constructor(opts: TerminalOutputOptions = {}) {
    this.synchronizedOutput = opts.synchronizedOutput ?? true;
  }

  init(): void {
    process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    this.inAltScreen = true;
    process.on("exit", this.exitHandler);
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);
    process.on("SIGTSTP", this.sigtstpHandler);
    this.sigtstpInstalled = true;
    process.on("SIGCONT", this.sigcontHandler);
  }

  write(frame: Frame, _label?: string): void {
    if (!this.inAltScreen) {
      this.init();
    }
    const grid = flatten(frame, frame.width, frame.height);
    const ansi = this.previousGrid && sameGridSize(this.previousGrid, grid)
      ? diffToANSI(this.previousGrid, grid)
      : CURSOR_HOME + gridToANSI(grid);
    this.previousGrid = grid;
    if (ansi.length === 0) return;
    // Wrap the full-frame write in BSU/ESU so supporting terminals
    // apply the new frame atomically instead of streaming the
    // repaint cell-by-cell (which the eye perceives as flicker).
    process.stdout.write(this.synchronizedOutput ? BEGIN_SYNC + ansi + END_SYNC : ansi);
  }

  destroy(): void {
    if (this.inAltScreen) {
      process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      this.inAltScreen = false;
    }
    this.previousGrid = null;
    this.removeSignalHandlers();
  }

  suspend(): void {
    if (this.inAltScreen) {
      process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
      this.inAltScreen = false;
    }
    this.previousGrid = null;
  }

  resume(): void {
    if (!this.inAltScreen) {
      process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
      this.inAltScreen = true;
    }
    this.previousGrid = null;
  }

  private removeSignalHandlers(): void {
    process.removeListener("exit", this.exitHandler);
    process.removeListener("SIGINT", this.sigintHandler);
    process.removeListener("SIGTERM", this.sigtermHandler);
    process.removeListener("SIGTSTP", this.sigtstpHandler);
    process.removeListener("SIGCONT", this.sigcontHandler);
    this.sigtstpInstalled = false;
  }
}
