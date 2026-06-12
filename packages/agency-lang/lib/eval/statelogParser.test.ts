import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EventEnvelope } from "../statelog/wireTypes.js";
import { extractEvalRecord } from "./extract.js";
import { normalize } from "./normalize.js";
import { StatelogParser } from "./statelogParser.js";

let ts = 0;

function nextTs(): string {
  ts += 100;
  return new Date(1_700_000_000_000 + ts).toISOString();
}

function resetClock(): void {
  ts = 0;
}

function event(
  type: string,
  data: Record<string, unknown> = {},
  traceId = "trace-A",
): EventEnvelope {
  return {
    format_version: 1,
    trace_id: traceId,
    project_id: "project",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: nextTs(), ...data },
  };
}

function writeJsonl(dir: string, events: EventEnvelope[]): string {
  const filePath = path.join(dir, "statelog.jsonl");
  fs.writeFileSync(filePath, events.map((ev) => JSON.stringify(ev)).join("\n"));
  return filePath;
}

describe("StatelogParser", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "statelog-parser-"));
    resetClock();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("projects eval values and records through a readable sync API", () => {
    const events = [
      event("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
      event("evalInputRecorded", { threadId: "0", value: "question" }),
      event("evalOutputRecorded", { threadId: "0", value: "draft" }),
      event("evalOutputRecorded", { threadId: "0", value: "answer" }),
    ];
    const statelogPath = writeJsonl(tmpDir, events);
    const log = new StatelogParser(statelogPath);
    const expected = extractEvalRecord(events, statelogPath);

    expect(log.evalRecord()).toEqual(expected);
    expect(log.normalized()).toEqual(normalize(events));
    expect(log.evalInputs()).toEqual(expected.evalInputs);
    expect(log.evalOutputs()).toEqual(expected.evalOutputs);
    expect(log.finalEvalOutput()).toEqual(expected.evalOutputs[1]);
    expect(log.threads()).toEqual(expected.threads);
    expect(log.normalizedEvents()).toEqual(expected.events);
    expect(log.interrupts()).toEqual(expected.interrupts);
    expect(log.errors()).toEqual(expected.errors);
    expect(log.incompleteInvocations()).toEqual(expected.incomplete);
    expect(log.metrics()).toEqual(expected.metrics);
    expect(log.warnings()).toEqual(expected.warnings);
  });

  it("returns null when there is no final eval output", () => {
    const statelogPath = writeJsonl(tmpDir, [
      event("threadCreated", { threadId: "0", threadType: "thread", label: "main" }),
    ]);

    expect(new StatelogParser(statelogPath).finalEvalOutput()).toBeNull();
  });

  it("rejects statelog files with more than one trace", () => {
    const statelogPath = writeJsonl(tmpDir, [
      event("threadCreated", { threadId: "0", threadType: "thread" }, "trace-A"),
      event("threadCreated", { threadId: "1", threadType: "thread" }, "trace-B"),
    ]);
    const log = new StatelogParser(statelogPath);

    expect(() => log.normalized()).toThrow(/multiple trace_ids/i);
    expect(() => log.evalRecord()).toThrow(/multiple trace_ids/i);
  });
});
