// What the program is waiting on, as the UI keeps and words it. The run
// sends the whole list of open waits each time it changes (`waits.ts`);
// the UI keeps each with the time it first saw it, and turns one into a
// line of text for the command bar, the stats bar, and the ADI-11
// `where` command, so all three say the same thing.
import type { BusyEntry } from "../runtime/waits.js";

/** An open wait as the UI holds it: the entry and the UI's clock
 *  reading when the wait began. */
export type BusyShown = { entry: BusyEntry; since: number };

/** The list to hold after the run sent `entries`: an entry already held,
 *  by its token, keeps its time; a new one began `elapsedMs` before
 *  `now`, so a UI that joins late shows the wait's whole length; one
 *  that is gone is dropped. A pure function of its inputs, so the order
 *  the notices arrive in is the only order there is. */
export function withSince(previous: BusyShown[], entries: BusyEntry[], now: number): BusyShown[] {
  return entries.map((entry) => {
    const known = previous.find((shown) => shown.entry.token === entry.token);
    return { entry, since: known?.since ?? now - entry.elapsedMs };
  });
}

/** A duration as the screen shows it: `4m10s`, `30s`, `250ms`. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m${seconds > 0 ? `${seconds}s` : ""}`;
  return `${hours}h${minutes % 60 > 0 ? `${minutes % 60}m` : ""}`;
}

/** The wait as one line: where the `llm()` statement is, how long the
 *  wait has been open, and what the loop is doing there. `line` is the
 *  statement's source line when the UI knows it. */
export function busyText(shown: BusyShown, line: number | undefined, now: number): string {
  const { entry } = shown;
  const file = entry.location.moduleId.split("/").pop() ?? entry.location.moduleId;
  const where = line === undefined ? file : `${file}:${line}`;
  const elapsed = formatElapsed(Math.max(0, now - shown.since));
  return `in llm() at ${where} · ${elapsed} · ${doing(entry)}`;
}

/** `round 1, waiting on model`, or `round 2, in tool search(query:
 *  "cats")`. A tool entry's label is the call, and the run says which
 *  round it is in (`round`, counted as the person counts). */
function doing(entry: BusyEntry): string {
  if (entry.kind === "model") {
    return `${entry.label}, waiting on model`;
  }
  const prefix = entry.round === undefined ? "" : `round ${entry.round}, `;
  return `${prefix}in tool ${entry.label}`;
}
