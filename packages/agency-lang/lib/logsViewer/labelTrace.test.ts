import { describe, expect, it, vi } from "vitest";

import { makeOutputId } from "@/eval/label/ids.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

import {
  labelTrace,
  type LabelTraceServices,
  type LabelTraceUI,
} from "./labelTrace.js";

let ts = 0;
function ev(type: string, data: Record<string, unknown> = {}): EventEnvelope {
  ts += 100;
  return {
    format_version: 1,
    trace_id: "T",
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: new Date(1_700_000_000_000 + ts).toISOString(), threadId: "0", ...data },
  };
}

function ui(over: Partial<LabelTraceUI> = {}): LabelTraceUI & { notes: string[] } {
  const notes: string[] = [];
  return {
    editTask: vi.fn(async () => ({ kind: "keep-default" as const })),
    notify: (message: string) => { notes.push(message); },
    notes,
    ...over,
  };
}

function services(): LabelTraceServices & { ingested: unknown[]; labeled: unknown[] } {
  const ingested: unknown[] = [];
  const labeled: unknown[] = [];
  return {
    datasetWriter: { ingest: (request) => { ingested.push(request); return {} as never; } },
    labelingHost: { run: async (request) => { labeled.push(request); } },
    ingested,
    labeled,
  };
}

const baseRequest = {
  traceId: "T",
  sourceName: "coder",
  sourcePath: "log.jsonl",
  datasetDir: "/tmp/ds",
  annotator: { kind: "human", id: "adit" } as const,
  checklistFile: "cl.json",
};

describe("labelTrace", () => {
  it("ingests then labels a resolved trace, focused on the computed output id", async () => {
    const svc = services();
    const outcome = await labelTrace(
      { ...baseRequest, events: [ev("evalOutputRecorded", { value: "answer" })] },
      ui(),
      svc,
    );
    const expectedId = makeOutputId({ output: "answer" });
    expect(outcome).toEqual({ kind: "labeled", outputId: expectedId });
    expect(svc.ingested).toHaveLength(1);
    expect(svc.labeled[0]).toMatchObject({ datasetDir: "/tmp/ds", checklistFile: "cl.json", focusOutputId: expectedId });
  });

  it("does not ingest and reports when there is nothing to judge", async () => {
    const svc = services();
    const outcome = await labelTrace({ ...baseRequest, events: [ev("agentStart")] }, ui(), svc);
    expect(outcome).toEqual({ kind: "rejected", reason: "no-output" });
    expect(svc.ingested).toHaveLength(0);
    expect(svc.labeled).toHaveLength(0);
  });

  it("rejects with missing-checklist and does not ingest", async () => {
    const svc = services();
    const theUi = ui();
    const outcome = await labelTrace(
      { ...baseRequest, checklistFile: undefined, events: [ev("evalOutputRecorded", { value: "answer" })] },
      theUi,
      svc,
    );
    expect(outcome).toEqual({ kind: "rejected", reason: "missing-checklist" });
    expect(theUi.notes.join(" ")).toContain("--checklist");
    expect(svc.ingested).toHaveLength(0);
  });

  it("cancels when the task editor is dismissed", async () => {
    const svc = services();
    const outcome = await labelTrace(
      { ...baseRequest, events: [ev("evalOutputRecorded", { value: "answer" })] },
      ui({ editTask: vi.fn(async () => null) }),
      svc,
    );
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(svc.labeled).toHaveLength(0);
  });

  it("propagates a labeling-host failure after ingesting", async () => {
    const svc = services();
    svc.labelingHost.run = async () => { throw new Error("host boom"); };
    await expect(labelTrace(
      { ...baseRequest, events: [ev("evalOutputRecorded", { value: "answer" })] },
      ui(),
      svc,
    )).rejects.toThrow("host boom");
  });
});
