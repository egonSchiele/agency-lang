import { makeAppendReader } from "./appendReader.js";
import { parseStatelogJsonl } from "./parse.js";
import type { EventEnvelope } from "./wireTypes.js";

/**
 * Pull-based tail of a LIVE statelog: each poll() returns the events
 * appended since the last poll. Only complete lines are parsed — the writer
 * is another process, so the file routinely ends mid-line; the partial tail
 * is held until a later poll completes it. Lines that fail to parse are
 * dropped (poll consumers want the latest numbers, not a crash); use
 * parseStatelogJsonl directly when parse errors matter.
 */
export function makeStatelogTailer(path: string): { poll(): EventEnvelope[] } {
  const reader = makeAppendReader(path);
  let partialLine = "";
  return {
    poll(): EventEnvelope[] {
      const lines = (partialLine + reader.read()).split("\n");
      partialLine = lines.pop() ?? "";
      return parseStatelogJsonl(lines.join("\n")).events;
    },
  };
}
