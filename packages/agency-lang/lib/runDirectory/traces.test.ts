import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "@/statelog/wireTypes.js";

import {
  matchTrace,
  matchTraceId,
  readTraces,
  resolveTraceIdArgument,
  traceDigest,
} from "./traces.js";

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
    const { traces } = readTraces(
      writeLog([first, first, line("aaa", "agentEnd")].join("\n") + "\n"),
    );
    expect(traces[0].events).toHaveLength(2);
  });

  it("ignores a torn last line and keeps the rest", () => {
    const { traces, errors } = readTraces(
      writeLog(line("aaa", "agentStart") + "\n" + line("aaa", "agentEnd").slice(0, 20)),
    );
    expect(errors).toEqual([]);
    expect(traces[0].events).toHaveLength(1);
  });

  it("returns nothing for an empty file", () => {
    expect(readTraces(writeLog(""))).toEqual({ traces: [], errors: [] });
  });

  it("keeps a complete last line that has no newline", () => {
    const file = writeLog(line("aaa", "agentStart") + "\n" + line("aaa", "agentEnd"));
    const { traces, errors } = readTraces(file);
    expect(errors).toEqual([]);
    expect(traces[0].events.map((event) => event.data.type)).toEqual(["agentStart", "agentEnd"]);
    expect(traces[0].lines[1]).toBe(line("aaa", "agentEnd"));
  });

  it("numbers a bad line by its place in the file across read chunks", () => {
    // Enough lines to span several of the reader's chunks.
    const padding = "p".repeat(2000);
    const lines = Array.from({ length: 600 }, (_, index) =>
      line("aaa", "note", { index, padding }),
    );
    lines[450] = "not json";
    const { traces, errors } = readTraces(writeLog(lines.join("\n") + "\n"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 451, kind: "invalid_json" });
    expect(traces[0].events).toHaveLength(599);
  });

  it("throws for a missing file", () => {
    expect(() => readTraces(path.join(os.tmpdir(), "no-such-statelog.jsonl"))).toThrow(/ENOENT/);
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
    const { traces } = readTraces(writeLog(line("aaa", "agentStart") + "\n"));
    expect(traces[0].digest).toBe(traceDigest(traces[0].events));
  });
});

describe("matchTrace", () => {
  const { traces } = readTraces(
    writeLog(
      [line("abc123", "agentStart"), line("abd456", "agentStart"), line("zzz", "agentStart")].join(
        "\n",
      ) + "\n",
    ),
  );

  it("matches a full id, a unique prefix, and reports ambiguity", () => {
    expect(matchTrace(traces, "zzz")).toMatchObject({ kind: "one" });
    expect(matchTrace(traces, "abc")).toMatchObject({ kind: "one" });
    expect(matchTrace(traces, "ab")).toEqual({ kind: "ambiguous", ids: ["abc123", "abd456"] });
    expect(matchTrace(traces, "nope")).toEqual({ kind: "none" });
  });
});

describe("matchTraceId", () => {
  it("prefers an exact id, then a unique prefix, and reports the rest", () => {
    const ids = ["k3Pq9abc", "k3Pzzzzz", "k3P"];
    expect(matchTraceId(ids, "k3P")).toEqual({ kind: "one", id: "k3P" });
    expect(matchTraceId(ids, "k3Pq")).toEqual({ kind: "one", id: "k3Pq9abc" });
    expect(matchTraceId(ids, "k3Pz")).toEqual({ kind: "one", id: "k3Pzzzzz" });
    expect(matchTraceId(ids, "k3")).toEqual({ kind: "ambiguous", ids });
    expect(matchTraceId(ids, "zz")).toEqual({ kind: "none" });
  });
});

describe("resolveTraceIdArgument", () => {
  const ids = ["k3Pq9abc", "k3Pzzzzz"];

  it("names the one trace a full id or a unique prefix matches", () => {
    expect(resolveTraceIdArgument(ids, "k3Pzzzzz")).toEqual({ kind: "one", id: "k3Pzzzzz" });
    expect(resolveTraceIdArgument(ids, "k3Pq")).toEqual({ kind: "one", id: "k3Pq9abc" });
  });

  it("explains an ambiguous prefix, a miss, and a log with no traces", () => {
    expect(resolveTraceIdArgument(ids, "k3P")).toEqual({
      kind: "problem",
      message: "--trace-id k3P is ambiguous: k3Pq9abc, k3Pzzzzz",
    });
    expect(resolveTraceIdArgument(ids, "nope")).toEqual({
      kind: "problem",
      message: "No trace matches --trace-id nope (found: k3Pq9abc, k3Pzzzzz)",
    });
    expect(resolveTraceIdArgument([], "nope")).toEqual({
      kind: "problem",
      message: "No trace matches --trace-id nope (the log holds no traces)",
    });
  });
});
