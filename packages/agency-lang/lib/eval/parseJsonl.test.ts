import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAllEvents } from "./parseJsonl.js";

describe("readAllEvents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-parsejsonl-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("returns [] for an empty file", async () => {
    const f = write("empty.jsonl", "");
    expect(await readAllEvents(f)).toEqual([]);
  });

  it("skips blank lines", async () => {
    const f = write(
      "blanks.jsonl",
      [
        "",
        JSON.stringify({ format_version: 1, trace_id: "t", project_id: "p", span_id: null, parent_span_id: null, data: { type: "a", timestamp: "2026-01-01T00:00:00.000Z" } }),
        "",
        "",
        JSON.stringify({ format_version: 1, trace_id: "t", project_id: "p", span_id: null, parent_span_id: null, data: { type: "b", timestamp: "2026-01-01T00:00:01.000Z" } }),
        "",
      ].join("\n"),
    );
    const events = await readAllEvents(f);
    expect(events.length).toBe(2);
    expect(events[0].data.type).toBe("a");
    expect(events[1].data.type).toBe("b");
  });

  it("reports the line number of a malformed line", async () => {
    const f = write(
      "bad.jsonl",
      [
        JSON.stringify({ format_version: 1, trace_id: "t", project_id: "p", span_id: null, parent_span_id: null, data: { type: "a", timestamp: "x" } }),
        "{not json",
      ].join("\n"),
    );
    await expect(readAllEvents(f)).rejects.toThrow(/Malformed JSON on line 2/);
  });

  it("parses a single event", async () => {
    const f = write(
      "single.jsonl",
      JSON.stringify({
        format_version: 1,
        trace_id: "t",
        project_id: "p",
        span_id: "s1",
        parent_span_id: null,
        data: { type: "a", timestamp: "2026-01-01T00:00:00.000Z" },
      }),
    );
    const events = await readAllEvents(f);
    expect(events.length).toBe(1);
    expect(events[0].span_id).toBe("s1");
  });

  it("parses many events in order", async () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({
        format_version: 1,
        trace_id: "t",
        project_id: "p",
        span_id: `s${i}`,
        parent_span_id: null,
        data: { type: "evt", timestamp: "2026-01-01T00:00:00.000Z", n: i },
      }),
    );
    const f = write("many.jsonl", lines.join("\n"));
    const events = await readAllEvents(f);
    expect(events.length).toBe(100);
    expect(events[0].data.n).toBe(0);
    expect(events[99].data.n).toBe(99);
  });
});
