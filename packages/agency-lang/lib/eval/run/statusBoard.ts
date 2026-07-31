import { color } from "@/utils/termcolors.js";

/**
 * Live one-line-per-test display for parallel suite runs, on stderr. On a
 * TTY it repaints in place every second; piped, it prints a plain snapshot
 * every 15 seconds instead. Display only — callers push state in via
 * update(); nothing here reads files or clocks besides "now".
 */
export type BoardStatus = "queued" | "running" | "done" | "error";

type BoardEntry = {
  id: string;
  status: BoardStatus;
  startedAt?: number;
  endedAt?: number;
  costUsd: number;
};

/** "47s" under a minute, "5m 17s" over. Shared with runSuite's sequential
 *  progress lines. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

export function startStatusBoard(ids: string[]): {
  update(id: string, patch: Partial<Omit<BoardEntry, "id">>): void;
  stop(): void;
} {
  const entries: BoardEntry[] = ids.map((id) => ({ id, status: "queued", costUsd: 0 }));
  const byId: Record<string, BoardEntry> = Object.fromEntries(entries.map((e) => [e.id, e]));
  const isTty = process.stderr.isTTY === true;
  const paint = isTty ? color : undefined;
  let painted = false;

  // Pad the plain text FIRST, colorize after: ANSI escapes inflate string
  // length unevenly (colored vs uncolored cells) and would skew columns.
  const cell = (text: string, width: number, colorize?: (s: string) => string): string => {
    const padded = text.padEnd(width);
    return colorize ? colorize(padded) : padded;
  };

  const line = (entry: BoardEntry): string => {
    const statusColor =
      entry.status === "error" ? paint?.red
      : entry.status === "done" ? paint?.green
      : undefined;
    const elapsed = entry.startedAt === undefined
      ? ""
      : formatElapsed((entry.endedAt ?? Date.now()) - entry.startedAt);
    const cost = entry.costUsd > 0 ? `$${entry.costUsd.toFixed(2)}` : "";
    return (
      `  ${cell(entry.id, 30, paint?.green)} ${cell(entry.status, 8, statusColor)} ` +
      `${cell(elapsed, 8)} ${cost}`
    ).trimEnd();
  };

  const render = () => {
    if (isTty && painted) {
      process.stderr.write(`\x1b[${entries.length}A`);
    }
    for (const entry of entries) {
      process.stderr.write((isTty ? "\x1b[2K" : "") + line(entry) + "\n");
    }
    painted = true;
  };

  render();
  const interval = setInterval(render, isTty ? 1_000 : 15_000);

  return {
    update(id, patch) {
      const entry = byId[id];
      if (entry) Object.assign(entry, patch);
    },
    stop() {
      clearInterval(interval);
      render();
    },
  };
}
