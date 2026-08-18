import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { matchTrace, readTraces, traceDigest, tracesFromText } from "./traces.js";

function line(traceId: string, type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format_version: 1,
    trace_id: traceId,
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: "2026-08-18T00:00:00Z", ...extra },
  });
}

function writeLog(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "traces-"));
  const file = path.join(dir, "statelog.jsonl");
  fs.writeFileSync(file, text);
  return file;
}

describe("readTraces", () => {
  it("groups events by trace id in first-seen order", () => {
    const file = writeLog(
      [line("aaa", "agentStart"), line("bbb", "agentStart"), line("aaa", "agentEnd")].join("\n") +
        "\n",
    );
    const { traces, errors } = readTraces(file);
    expect(errors).toEqual([]);
    expect(traces.map((trace) => trace.traceId)).toEqual(["aaa", "bbb"]);
    expect(traces[0].events).toHaveLength(2);
    expect(traces[0].lines).toHaveLength(2);
    expect(traces[1].events).toHaveLength(1);
  });

  it("drops a duplicated identical line", () => {
    const first = line("aaa", "agentStart");
    const { traces } = tracesFromText([first, first, line("aaa", "agentEnd")].join("\n") + "\n");
    expect(traces[0].events).toHaveLength(2);
  });

  it("ignores a torn last line and keeps the rest", () => {
    const { traces, errors } = tracesFromText(
      line("aaa", "agentStart") + "\n" + line("aaa", "agentEnd").slice(0, 20),
    );
    expect(errors).toEqual([]);
    expect(traces[0].events).toHaveLength(1);
  });

  it("returns nothing for an empty file", () => {
    expect(tracesFromText("")).toEqual({ traces: [], errors: [] });
  });
});

describe("traceDigest", () => {
  const event = (data: Record<string, unknown>): EventEnvelope => ({
    format_version: 1,
    trace_id: "t",
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type: "x", timestamp: "now", ...data },
  });

  it("ignores key order", () => {
    expect(traceDigest([event({ a: 1, b: 2 })])).toBe(traceDigest([event({ b: 2, a: 1 })]));
  });

  it("changes when a value changes or events reorder", () => {
    const base = traceDigest([event({ a: 1 }), event({ a: 2 })]);
    expect(traceDigest([event({ a: 1 }), event({ a: 3 })])).not.toBe(base);
    expect(traceDigest([event({ a: 2 }), event({ a: 1 })])).not.toBe(base);
  });

  it("is the digest readTraces records", () => {
    const { traces } = tracesFromText(line("aaa", "agentStart") + "\n");
    expect(traces[0].digest).toBe(traceDigest(traces[0].events));
  });
});

describe("matchTrace", () => {
  const { traces } = tracesFromText(
    [line("abc123", "agentStart"), line("abd456", "agentStart"), line("zzz", "agentStart")].join(
      "\n",
    ) + "\n",
  );

  it("matches a full id, a unique prefix, and reports ambiguity", () => {
    expect(matchTrace(traces, "zzz")).toMatchObject({ kind: "one" });
    expect(matchTrace(traces, "abc")).toMatchObject({ kind: "one" });
    expect(matchTrace(traces, "ab")).toEqual({ kind: "ambiguous", ids: ["abc123", "abd456"] });
    expect(matchTrace(traces, "nope")).toEqual({ kind: "none" });
  });
});
