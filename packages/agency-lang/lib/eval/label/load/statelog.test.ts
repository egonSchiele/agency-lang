import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EventEnvelope } from "@/statelog/wireTypes.js";

import { loadStatelog, projectTrace, resolveTrace, type ResolvedTrace } from "./statelog.js";
import { IngestSourceError } from "./types.js";

let ts = 0;
function nextTs(): string {
  ts += 100;
  return new Date(1_700_000_000_000 + ts).toISOString();
}

function ev(type: string, data: Record<string, unknown> = {}, traceId = "T"): EventEnvelope {
  return {
    format_version: 1,
    trace_id: traceId,
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: nextTs(), threadId: "0", ...data },
  };
}

function resolve(events: EventEnvelope[]) {
  return resolveTrace(events, "source.jsonl");
}

/** A clean, result-less terminal footer — the shape a run that ends via
 *  `evalOutput()` writes. Every "resolved" fixture needs a terminal `agentEnd`,
 *  because a real completed run always emits one. */
function end(data: Record<string, unknown> = {}, traceId = "T"): EventEnvelope {
  return ev("agentEnd", data, traceId);
}

const CONTEXT = { source: "s", constantFields: {}, maxBytes: 1_048_576 };

describe("resolveTrace", () => {
  it("uses an explicit eval output, at the last explicit index", () => {
    const result = resolve([
      ev("evalOutputRecorded", { value: "first" }),
      ev("evalOutputRecorded", { value: "second" }),
      end(),
    ]);
    expect(result).toEqual({
      kind: "resolved",
      trace: { output: "second", finalOutputIndex: 1, taskDefault: null },
    });
  });

  it("uses the entry-node return value when no eval output was recorded", () => {
    const result = resolve([end({ result: "returned" })]);
    expect(result).toMatchObject({ kind: "resolved", trace: { output: "returned" } });
  });

  it("rejects a truncated explicit output", () => {
    const result = resolve([ev("evalOutputRecorded", { value: "x".repeat(300_000) }), end()]);
    expect(result).toEqual({ kind: "rejected", reason: "truncated-output" });
  });

  it("rejects with no-output when there is nothing to judge", () => {
    expect(resolve([ev("agentStart"), end()])).toEqual({ kind: "rejected", reason: "no-output" });
  });

  it("rejects a trace that crashed after recording an output", () => {
    // The runtime's crash footer: a terminal runtimeError, then a result-less
    // agentEnd. Run-directory ingestion rejects the same as `run-failed`.
    const result = resolve([
      ev("evalOutputRecorded", { value: "answer" }),
      ev("error", { errorType: "runtimeError", message: "boom" }),
      end(),
    ]);
    expect(result).toEqual({ kind: "rejected", reason: "run-failed" });
  });

  it("still accepts a run that recovered from a transient tool error", () => {
    // A retried/handled toolError is not terminal, so a completed run may carry
    // one and still be labelable.
    const result = resolve([
      ev("error", { errorType: "toolError", message: "ret--y" }),
      ev("evalOutputRecorded", { value: "answer" }),
      end(),
    ]);
    expect(result).toMatchObject({ kind: "resolved", trace: { output: "answer" } });
  });

  it("rejects an unfinished trace that never reached its footer", () => {
    const result = resolve([ev("evalOutputRecorded", { value: "answer" })]);
    expect(result).toEqual({ kind: "rejected", reason: "trace-unfinished" });
  });

  it("infers the task from the first prompt when no evalValue was recorded", () => {
    const result = resolve([
      ev("promptCompletion", { messages: [{ role: "user", content: "the question" }] }),
      ev("evalOutputRecorded", { value: "answer" }),
      end(),
    ]);
    expect(result).toMatchObject({ kind: "resolved", trace: { taskDefault: "the question" } });
  });

  it("keeps a structured explicit eval value as the task default", () => {
    const result = resolve([
      ev("evalValueRecorded", { value: { q: 1 } }),
      ev("evalOutputRecorded", { value: "answer" }),
      end(),
    ]);
    expect(result).toMatchObject({ kind: "resolved", trace: { taskDefault: { q: 1 } } });
  });
});

describe("projectTrace", () => {
  const resolved: ResolvedTrace = {
    output: "answer",
    finalOutputIndex: 0,
    taskDefault: "the task",
  };

  it("projects a resolved trace into an occurrence with a statelog origin", () => {
    expect(projectTrace("T", resolved, { kind: "keep-default" }, CONTEXT)).toEqual({
      kind: "accepted",
      occurrence: {
        fields: { task: "the task", output: "answer" },
        source: "s",
        origin: { kind: "statelog", traceId: "T", finalOutputIndex: 0 },
      },
    });
  });

  it("omits the task field when asked", () => {
    const result = projectTrace("T", resolved, { kind: "omit" }, CONTEXT);
    expect((result as any).occurrence.fields).toEqual({ output: "answer" });
  });

  it("replaces the task with a provided value", () => {
    const result = projectTrace("T", resolved, { kind: "replace", value: "edited" }, CONTEXT);
    expect((result as any).occurrence.fields.task).toBe("edited");
  });

  it("projects a structured task default", () => {
    const structured: ResolvedTrace = { ...resolved, taskDefault: { q: 1 } };
    const result = projectTrace("T", structured, { kind: "keep-default" }, CONTEXT);
    expect((result as any).occurrence.fields.task).toBe(JSON.stringify({ q: 1 }));
  });

  it("skips when the projected output is too large", () => {
    const result = projectTrace("T", resolved, { kind: "omit" }, { ...CONTEXT, maxBytes: 4 });
    expect(result).toEqual({ kind: "skipped", skip: { item: "T", reason: "too-large" } });
  });
});

describe("loadStatelog", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadstatelog-"));
    // Trace A: an eval output (resolved). Trace B: nothing to judge. Both reach
    // a terminal footer, as a real completed run does.
    const events = [
      ev("evalOutputRecorded", { value: "answer A" }, "A"),
      ev("agentEnd", {}, "A"),
      ev("agentStart", {}, "B"),
      ev("agentEnd", {}, "B"),
    ];
    file = path.join(dir, "log.jsonl");
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const load = (traceIds: string[]) =>
    loadStatelog({
      path: file,
      traceIds,
      source: "s",
      constantFields: {},
      includeTaskField: true,
      maxBytes: 1_048_576,
    });

  it("promotes a resolved trace", () => {
    const batch = load(["A"]);
    expect(batch.occurrences).toHaveLength(1);
    expect(batch.occurrences[0].origin).toMatchObject({
      kind: "statelog",
      traceId: "A",
      finalOutputIndex: 0,
    });
  });

  it("skips a trace with nothing to judge", () => {
    const batch = load(["B"]);
    expect(batch.occurrences).toHaveLength(0);
    expect(batch.skips).toEqual([{ item: "B", reason: "no-output" }]);
  });

  it("errors with the trace list when no --trace is given", () => {
    expect(() => load([])).toThrow(/at least one --trace/);
    expect(() => load([])).toThrow(/Available traces/);
  });

  it("errors naming available traces for an unknown id", () => {
    expect(() => load(["ZZ"])).toThrow(IngestSourceError);
    expect(() => load(["ZZ"])).toThrow(/No trace in .* matches "ZZ"/);
  });

  describe("prefix trace ids", () => {
    let pdir: string;
    let pfile: string;
    beforeEach(() => {
      pdir = fs.mkdtempSync(path.join(os.tmpdir(), "loadstatelog-prefix-"));
      const events = [
        ev("evalOutputRecorded", { value: "answer" }, "abc123"),
        ev("agentEnd", {}, "abc123"),
        ev("evalOutputRecorded", { value: "answer2" }, "abc999"),
        ev("agentEnd", {}, "abc999"),
      ];
      pfile = path.join(pdir, "log.jsonl");
      fs.writeFileSync(pfile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    });
    afterEach(() => {
      fs.rmSync(pdir, { recursive: true, force: true });
    });
    const loadFrom = (traceIds: string[]) =>
      loadStatelog({
        path: pfile,
        traceIds,
        source: "s",
        constantFields: {},
        includeTaskField: true,
        maxBytes: 1_048_576,
      });

    it("resolves a unique prefix to the full id and records the full id", () => {
      const batch = loadFrom(["abc1"]);
      expect(batch.occurrences).toHaveLength(1);
      expect(batch.occurrences[0].origin).toMatchObject({ kind: "statelog", traceId: "abc123" });
    });

    it("rejects a prefix shared by more than one trace, listing the candidates", () => {
      expect(() => loadFrom(["abc"])).toThrow(/ambiguous/);
      expect(() => loadFrom(["abc"])).toThrow(/abc123/);
      expect(() => loadFrom(["abc"])).toThrow(/abc999/);
    });
  });
});
