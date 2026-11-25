import { describe, expect, it } from "vitest";
import {
  parseStatelogJsonl,
  parseStatelogJsonlWithLines,
  parseStatelogLines,
  parseStatelogRecords,
} from "./parse.js";
import type { RebuildState } from "./threadMessages/read.js";
import { THREE_CALLS, threeCallLines } from "./threadMessages/testFixtures.js";

describe("parsing a log with change events", () => {
  it("parseStatelogJsonl returns full lists for change events", () => {
    const lines = threeCallLines();
    const whole = parseStatelogJsonl(lines.join("\n"));
    expect(whole.events.map((event) => event.data.messages)).toEqual(THREE_CALLS);

    const rebuild: RebuildState = {};
    const firstChunk = parseStatelogLines(lines.slice(0, 2), 1, rebuild);
    const secondChunk = parseStatelogLines(lines.slice(2), 3, rebuild);
    const chunked = [...firstChunk.lines, ...secondChunk.lines].map((entry) => entry.event);
    expect(chunked).toEqual(whole.events);
  });

  it("a parsed line keeps the event as the file holds it", () => {
    const entry = parseStatelogJsonlWithLines(threeCallLines().join("\n")).lines[2];
    expect(entry.stored.data.newMessages).toEqual(THREE_CALLS[2].slice(3));
    expect(entry.stored.data.messages).toBeUndefined();
    expect(entry.event.data.messages).toEqual(THREE_CALLS[2]);
  });

  it("parseStatelogRecords rebuilds records that arrive out of order", () => {
    const records = threeCallLines()
      .map((line) => JSON.parse(line))
      .reverse();
    const { events } = parseStatelogRecords(records);
    expect(events.map((event) => event.data.messages)).toEqual([...THREE_CALLS].reverse());
  });
});
