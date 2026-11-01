import { makeLineReader } from "./lineReader.js";
import { parseStatelogLines } from "./parse.js";
import type { EventEnvelope } from "./wireTypes.js";

/**
 * Pull-based tail of a LIVE statelog: each poll() returns the events
 * appended since the last poll. The reader returns complete lines only, so a
 * line the writer has not finished waits for a later poll. Lines that fail
 * to parse are dropped (poll consumers want the latest numbers, not a
 * crash), which is also why their line numbers do not matter here.
 */
export function makeStatelogTailer(path: string): { poll(): EventEnvelope[] } {
  const reader = makeLineReader(path);
  return {
    poll(): EventEnvelope[] {
      const events: EventEnvelope[] = [];
      reader.readToEnd((lines) => {
        for (const entry of parseStatelogLines(lines, 1).lines) {
          events.push(entry.event);
        }
      });
      return events;
    },
  };
}
