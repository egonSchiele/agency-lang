import process from "process";

// All ANSI escapes for the hybrid-rendering scroll-region mechanism
// live in this file. The rest of lib/stdlib/ goes through the helpers
// below (or renders via lib/tui/) — no other source file in lib/stdlib/
// should emit raw escape codes for region management.
//
// The mechanism: `installRegion(N)` reserves the bottom N rows of the
// terminal for the bounded TUI Screen (rendered via
// `BottomRegionOutputTarget`) and sets the terminal's native scroll
// region to rows 1..(rows-N) so anything written to stdout scrolls
// inside the top region while the bottom is preserved.
//
// `withBottomCursor(fn)` is the only safe way to write to the bottom
// region — it saves the cursor, moves to the start of the bottom
// region, runs `fn` (which writes a frame), and restores the cursor
// so subsequent stdout writes still land in the scroll region.
//
// `onResize()` recomputes the split after a SIGWINCH;
// `installResizeHandler()` wires up the listener.

const ESC = "\x1b";
const CSI = `${ESC}[`;

let installedBottomRows = 0;
let scrollBottom = 0;
let resizeListener: (() => void) | null = null;
let cleanupInstalled = false;

// Emergency cleanup invoked from "exit" and SIGINT/SIGTERM handlers
// when the process is being torn down without the Agency-side
// `repl()` getting a chance to run its `finally` block (e.g. user
// hits Ctrl+C during a long-running tool call). Restores the scroll
// region and stdin raw mode so the shell prompt comes back clean.
function emergencyReset(): void {
  if (installedBottomRows > 0 && process.stdout.isTTY) {
    process.stdout.write(`${CSI}r`);
    process.stdout.write("\n");
  }
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
  }
  installedBottomRows = 0;
  scrollBottom = 0;
}

function ensureCleanupInstalled(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", emergencyReset);
  process.on("SIGINT", () => {
    emergencyReset();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    emergencyReset();
    process.exit(143);
  });
}

/**
 * Row (1-indexed) where the scroll region ends and the bottom region
 * begins. Returns 0 before `installRegion` runs or in non-TTY mode.
 */
export function scrollBottomRow(): number {
  return scrollBottom;
}

/**
 * Install the terminal scroll region so the top `H - bottomRows` rows
 * scroll natively (preserving scrollback, copy-paste, mouse-select)
 * and the bottom `bottomRows` rows are reserved for the TUI Screen
 * to render via `BottomRegionOutputTarget`. Idempotent. No-op when
 * stdout is not a TTY (the caller falls back to line-buffered output).
 */
export function installRegion(bottomRows: number): void {
  installedBottomRows = bottomRows;
  if (!process.stdout.isTTY) {
    scrollBottom = 0;
    return;
  }
  ensureCleanupInstalled();
  const rows = process.stdout.rows ?? 24;
  scrollBottom = Math.max(1, rows - bottomRows);
  process.stdout.write(`${CSI}1;${scrollBottom}r`);
}

/**
 * Reset the terminal to its default (full) scroll region and print a
 * trailing newline so the next shell prompt lands below the bottom
 * region after the REPL exits. Idempotent.
 */
export function resetRegion(): void {
  if (!process.stdout.isTTY) {
    installedBottomRows = 0;
    scrollBottom = 0;
    return;
  }
  process.stdout.write(`${CSI}r`);
  process.stdout.write("\n");
  installedBottomRows = 0;
  scrollBottom = 0;
}

/**
 * Save the cursor, move to the start of the bottom region, run `fn`
 * (which should write a frame to stdout via the wrapped OutputTarget),
 * restore the cursor. Keeps stdout's logical cursor inside the scroll
 * region so subsequent plain writes don't corrupt the bottom region.
 *
 * In non-TTY mode the cursor moves are skipped but `fn` still runs.
 */
export function withBottomCursor(fn: () => void): void {
  if (!process.stdout.isTTY) {
    fn();
    return;
  }
  process.stdout.write(`${CSI}s`);
  process.stdout.write(`${CSI}${scrollBottom + 1};1H`);
  fn();
  process.stdout.write(`${CSI}u`);
}

/**
 * Recompute the scroll-region split after a terminal resize. Re-reads
 * `process.stdout.rows` and re-issues the scroll-region escape with
 * the same `installedBottomRows` value. Called from a SIGWINCH
 * listener installed via `installResizeHandler`, or directly from
 * tests.
 */
export function onResize(): void {
  if (installedBottomRows > 0) {
    installRegion(installedBottomRows);
  }
}

/**
 * Install a SIGWINCH listener that re-issues the scroll region on
 * terminal resize. Returns a teardown function that removes the
 * listener. Idempotent — calling twice without teardown still leaves
 * exactly one listener installed.
 */
export function installResizeHandler(): () => void {
  if (resizeListener) {
    return () => {
      if (resizeListener) {
        process.stdout.removeListener("resize", resizeListener);
        resizeListener = null;
      }
    };
  }
  resizeListener = () => onResize();
  process.stdout.on("resize", resizeListener);
  return () => {
    if (resizeListener) {
      process.stdout.removeListener("resize", resizeListener);
      resizeListener = null;
    }
  };
}
