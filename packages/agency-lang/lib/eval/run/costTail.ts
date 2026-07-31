import * as fs from "fs";

/**
 * Incremental reader of a live statelog's LLM spend: each poll() reads the
 * bytes appended since the last poll, sums the cost on promptCompletion
 * events, and returns the running total. One partial trailing line is normal
 * mid-append (the writer is another process); it is kept and re-parsed once
 * complete. Torn lines under concurrent writers are skipped, not fatal —
 * this feeds a cost cap and a status display, and both prefer a slightly
 * stale number to a crash.
 *
 * Used by the spawn runner's cost cap (command targets have no IPC channel
 * to stream cost telemetry over) and the parallel status board.
 */
export function makeStatelogCostTailer(statelogPath: string): { poll(): number } {
  let offset = 0;
  let remainder = "";
  let total = 0;
  return {
    poll(): number {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(statelogPath);
      } catch {
        return total;   // no statelog yet
      }
      if (stats.size <= offset) return total;
      const fd = fs.openSync(statelogPath, "r");
      const buf = Buffer.alloc(stats.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = stats.size;
      const chunks = (remainder + buf.toString("utf8")).split("\n");
      remainder = chunks.pop() ?? "";
      for (const line of chunks) {
        if (line.trim() === "") continue;
        let event: { data?: { type?: string; cost?: { totalCost?: unknown } } };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.data?.type !== "promptCompletion") continue;
        const cost = event.data.cost?.totalCost;
        if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
          total += cost;
        }
      }
      return total;
    },
  };
}
