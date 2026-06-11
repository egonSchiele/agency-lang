import * as fs from "fs";
import * as readline from "readline";

import type { EventEnvelope } from "../statelog/wireTypes.js";

/** Read a `.statelog.jsonl` file line by line and yield each event.
 *  Skips blank lines. Throws on the first malformed JSON line — the
 *  CLI wrapper catches and reports the line number. Streaming so
 *  large traces don't load the whole file into memory.
 *
 *  Stdin is intentionally NOT supported: every realistic use case
 *  is "I have a captured trace on disk and want to extract it".
 *  Skipping stdin keeps the contract simple and the `source` field
 *  on the record always a real path. */
export async function* readEvents(file: string): AsyncIterable<EventEnvelope> {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    const line = raw.trim();
    if (line === "") continue;
    try {
      yield JSON.parse(line) as EventEnvelope;
    } catch (err) {
      throw new Error(
        `Malformed JSON on line ${lineNo}: ${(err as Error).message}`,
      );
    }
  }
}

/** Convenience wrapper that materializes the whole stream. Most
 *  use cases need random access (span lookups, ordering), so we
 *  pay the memory cost. Streaming is preserved at the I/O boundary. */
export async function readAllEvents(file: string): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  for await (const ev of readEvents(file)) out.push(ev);
  return out;
}

/** Synchronous variant for small, file-oriented facades such as
 *  StatelogParser. Keeps JSONL validation semantics aligned with
 *  readEvents(): blank lines are skipped, and malformed JSON reports
 *  the source line number. */
export function readAllEventsSync(file: string): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as EventEnvelope);
    } catch (err) {
      throw new Error(
        `Malformed JSON on line ${index + 1}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}
