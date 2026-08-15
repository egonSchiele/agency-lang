import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EventEnvelope } from "@/statelog/wireTypes.js";

import {
  loadStatelog,
  projectTrace,
  resolveTrace,
  type ResolvedTrace,
} from "./statelog.js";
import { IngestSourceError, type StatelogSelectionRequest } from "./types.js";

let ts = 0;
function nextTs(): string {
  ts += 100;
  return new Date(1_700_000_000_000 + ts).toISOString();
}

function ev(type: string, data: Record<string, unknown> = {}): EventEnvelope {
  return {
    format_version: 1,
    trace_id: "T",
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: nextTs(), threadId: "0", ...data },
  };
}

function resolve(events: EventEnvelope[]) {
  return resolveTrace(events, "source.jsonl");
}

const CONTEXT = { source: "s", constantFields: {}, maxBytes: 1_048_576 };

describe("resolveTrace output precedence", () => {
  it("uses an explicit eval output, at the last explicit index", () => {
    const result = resolve([
      ev("evalOutputRecorded", { value: "first" }),
      ev("evalOutputRecorded", { value: "second" }),
    ]);
    expect(result).toEqual({
      kind: "resolved",
      trace: { selection: { source: { kind: "evalOutput", index: 1 }, output: "second" }, taskDefault: null },
    });
  });

  it("uses the entry-node return value when no eval output was recorded", () => {
    const result = resolve([ev("agentEnd", { result: "returned" })]);
    expect(result).toMatchObject({
      kind: "resolved",
      trace: { selection: { source: { kind: "return" }, output: "returned" } },
    });
  });

  it("rejects a truncated explicit output rather than falling through to prints", () => {
    const result = resolve([
      ev("evalOutputRecorded", { value: "x".repeat(300_000) }),
      ev("print", { kind: "print", value: "clean", truncated: false }),
    ]);
    expect(result).toEqual({ kind: "rejected", reason: "truncated-output" });
  });

  it("auto-resolves a single clean print when there is no eval output", () => {
    const result = resolve([ev("print", { kind: "print", value: "only", truncated: false })]);
    expect(result).toMatchObject({
      kind: "resolved",
      trace: { selection: { source: { kind: "print", index: 0 }, output: "only" } },
    });
  });

  it("needs selection when several clean prints exist", () => {
    const result = resolve([
      ev("print", { kind: "print", value: "one", truncated: false }),
      ev("print", { kind: "printJSON", value: "two", truncated: false }),
    ]);
    expect(result).toMatchObject({
      kind: "needs-selection",
      candidates: [{ index: 0, value: "one" }, { index: 1, value: "two" }],
    });
  });

  it("keeps print indexes stable across a dropped truncated print", () => {
    const result = resolve([
      ev("print", { kind: "print", value: "big", truncated: true }),
      ev("print", { kind: "print", value: "a", truncated: false }),
      ev("print", { kind: "print", value: "b", truncated: false }),
    ]);
    expect(result).toMatchObject({
      kind: "needs-selection",
      candidates: [{ index: 1, value: "a" }, { index: 2, value: "b" }],
    });
  });

  it("rejects with no-output when there is nothing to judge", () => {
    const result = resolve([ev("agentStart")]);
    expect(result).toEqual({ kind: "rejected", reason: "no-output" });
  });

  it("rejects with truncated-output when the only prints are truncated", () => {
    const result = resolve([ev("print", { kind: "print", value: "big", truncated: true })]);
    expect(result).toEqual({ kind: "rejected", reason: "truncated-output" });
  });
});

describe("resolveTrace task default", () => {
  it("infers the task from the first prompt when no evalValue was recorded", () => {
    const result = resolve([
      ev("promptCompletion", { messages: [{ role: "user", content: "the question" }] }),
      ev("evalOutputRecorded", { value: "answer" }),
    ]);
    expect(result).toMatchObject({ kind: "resolved", trace: { taskDefault: "the question" } });
  });

  it("keeps a structured explicit eval value as the task default", () => {
    const result = resolve([
      ev("evalValueRecorded", { value: { q: 1 } }),
      ev("evalOutputRecorded", { value: "answer" }),
    ]);
    expect(result).toMatchObject({ kind: "resolved", trace: { taskDefault: { q: 1 } } });
  });
});

describe("projectTrace", () => {
  const resolved: ResolvedTrace = {
    selection: { source: { kind: "evalOutput", index: 0 }, output: "answer" },
    taskDefault: "the task",
  };

  it("projects a resolved trace into an occurrence with a statelog origin", () => {
    const result = projectTrace("T", resolved, { kind: "keep-default" }, CONTEXT);
    expect(result).toEqual({
      kind: "accepted",
      occurrence: {
        fields: { task: "the task", output: "answer" },
        source: "s",
        origin: { kind: "statelog", traceId: "T", outputSource: { kind: "evalOutput", index: 0 } },
      },
    });
  });

  it("omits the task field when asked", () => {
    const result = projectTrace("T", resolved, { kind: "omit" }, CONTEXT);
    expect(result).toMatchObject({ kind: "accepted", occurrence: { fields: { output: "answer" } } });
    expect((result as any).occurrence.fields.task).toBeUndefined();
  });

  it("replaces the task with a provided value", () => {
    const result = projectTrace("T", resolved, { kind: "replace", value: "edited" }, CONTEXT);
    expect((result as any).occurrence.fields.task).toBe("edited");
  });

  it("projects a structured task default through projectArtifactField", () => {
    const structured: ResolvedTrace = { ...resolved, taskDefault: { q: 1 } };
    const result = projectTrace("T", structured, { kind: "keep-default" }, CONTEXT);
    expect((result as any).occurrence.fields.task).toBe(JSON.stringify({ q: 1 }));
  });

  it("skips when the projected output is too large", () => {
    const big: ResolvedTrace = { ...resolved, selection: { source: { kind: "return" }, output: "x".repeat(10) } };
    const result = projectTrace("T", big, { kind: "omit" }, { ...CONTEXT, maxBytes: 4 });
    expect(result).toEqual({ kind: "skipped", skip: { item: "T", reason: "too-large" } });
  });
});

describe("loadStatelog", () => {
  let dir: string;
  let file: string;

  function evT(traceId: string, type: string, data: Record<string, unknown> = {}): EventEnvelope {
    return {
      format_version: 1,
      trace_id: traceId,
      project_id: "p",
      span_id: null,
      parent_span_id: null,
      data: { type, timestamp: nextTs(), threadId: "0", ...data },
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadstatelog-"));
    // Trace A: a clean eval output (resolved). Trace B: two prints (ambiguous).
    const events = [
      evT("A", "evalOutputRecorded", { value: "answer A" }),
      evT("B", "print", { kind: "print", value: "b-one", truncated: false }),
      evT("B", "print", { kind: "print", value: "b-two", truncated: false }),
    ];
    file = path.join(dir, "log.jsonl");
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const request = (over: Partial<StatelogSelectionRequest> = {}): StatelogSelectionRequest => ({
    traceIds: [],
    printSelections: {},
    ...over,
  });

  const load = (req: StatelogSelectionRequest) =>
    loadStatelog({ path: file, request: req, source: "s", constantFields: {}, includeTaskField: true, maxBytes: 1_048_576 });

  it("promotes a resolved trace", () => {
    const batch = load(request({ traceIds: ["A"] }));
    expect(batch.occurrences).toHaveLength(1);
    expect(batch.occurrences[0].origin).toMatchObject({ kind: "statelog", traceId: "A", outputSource: { kind: "evalOutput" } });
  });

  it("errors with the trace list when no --trace is given", () => {
    expect(() => load(request())).toThrow(/at least one --trace/);
    expect(() => load(request())).toThrow(/Available traces/);
  });

  it("errors naming available traces for an unknown id", () => {
    expect(() => load(request({ traceIds: ["ZZ"] }))).toThrow(/"ZZ" is not in/);
  });

  it("errors asking for a print selector on an ambiguous trace", () => {
    expect(() => load(request({ traceIds: ["B"] }))).toThrow(/Pick one with --output B=print/);
  });

  it("promotes the chosen print of an ambiguous trace", () => {
    const batch = load(request({ traceIds: ["B"], printSelections: { B: 1 } }));
    expect(batch.occurrences[0].origin).toMatchObject({ outputSource: { kind: "print", index: 1 } });
    expect(batch.occurrences[0].fields.output).toBe("b-two");
  });

  it("rejects a selector for an already-resolved trace", () => {
    expect(() => load(request({ traceIds: ["A"], printSelections: { A: 0 } }))).toThrow(/already has a definite output/);
  });

  it("rejects an out-of-range print index", () => {
    expect(() => load(request({ traceIds: ["B"], printSelections: { B: 9 } }))).toThrow(/no printed value at index 9/);
  });

  it("throws IngestSourceError for a bad selection", () => {
    expect(() => load(request({ traceIds: ["ZZ"] }))).toThrow(IngestSourceError);
  });
});
