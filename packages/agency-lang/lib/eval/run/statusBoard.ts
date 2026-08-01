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
  // Null prototype: ids come from suite input ids (potentially remote
  // content), and a key like "__proto__" on a normal object would corrupt
  // lookups instead of just naming a test.
  const byId: Record<string, BoardEntry> = Object.create(null);
  for (const entry of entries) byId[entry.id] = entry;
  const isTty = process.stderr.isTTY === true;
  const paint = isTty ? color : undefined;
  let painted = false;

  // The in-place repaint climbs one terminal row per entry, so a line must
  // never wrap: each row is truncated to the terminal width. Pad and
  // truncate the PLAIN text, colorize after — ANSI escapes inflate string
  // length unevenly (colored vs uncolored cells) and would skew both the
  // columns and the truncation point.
  const line = (entry: BoardEntry): string => {
    let statusColor: ((s: string) => string) | undefined;
    if (entry.status === "error") {
      statusColor = paint?.red;
    } else if (entry.status === "done") {
      statusColor = paint?.green;
    }
    const elapsed = entry.startedAt === undefined
      ? ""
      : formatElapsed((entry.endedAt ?? Date.now()) - entry.startedAt);
    const cost = entry.costUsd > 0 ? `$${entry.costUsd.toFixed(2)}` : "";

    let remaining = isTty ? (process.stderr.columns ?? 80) : Number.MAX_SAFE_INTEGER;
    const parts: string[] = [];
    const cell = (text: string, width: number | undefined, colorize?: (s: string) => string) => {
      const padded = width === undefined ? text : text.padEnd(width);
      const taken = padded.slice(0, Math.max(0, remaining));
      remaining -= taken.length;
      parts.push(colorize ? colorize(taken) : taken);
    };
    cell("  ", undefined);
    cell(entry.id, 30, paint?.green);
    cell(" ", undefined);
    cell(entry.status, 8, statusColor);
    cell(" ", undefined);
    cell(elapsed, 8);
    cell(" ", undefined);
    cell(cost, undefined);
    return parts.join("").trimEnd();
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
