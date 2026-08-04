import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeIngestSkip } from "./eligibility.js";
import { loadRun, selectLabelingFinalOutput, type LoadRunArgs } from "./run.js";
import { DEFAULT_MAX_INGEST_BYTES } from "./types.js";

let root: string;
let sourceDir: string;
const warnings: string[] = [];

type SourceInput = {
  inputId: string;
  status?: "success" | "error";
  task?: unknown;
  traceId?: string;
  outputs?: unknown[];
  omitRecord?: boolean;
  legacyShape?: boolean;
};

function writeSource(inputs: SourceInput[], options: { dir?: string } = {}): string {
  const dir = options.dir ?? sourceDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    provenance: { agent: { kind: "file", entry: "news.agency" } },
  }));
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({
    runId: path.basename(dir),
    runDir: dir,
    agentLabel: "news.agency:main",
    okCount: inputs.length,
    errorCount: 0,
    inputs: inputs.map((input) => ({
      inputId: input.inputId,
      status: input.status ?? "success",
      evalRecordPath: path.join(dir, "inputs", input.inputId, "agent", "eval-record.json"),
      statelogPath: "",
      workdirPath: "",
    })),
  }));
  for (const input of inputs) {
    const inputDir = path.join(dir, "inputs", input.inputId);
    fs.mkdirSync(path.join(inputDir, "agent"), { recursive: true });
    fs.writeFileSync(path.join(inputDir, "input.json"), JSON.stringify({
      id: input.inputId,
      task: input.task === undefined ? "do a thing" : input.task,
    }));
    if (input.omitRecord === true) {
      continue;
    }
    const record = input.legacyShape === true
      ? { traceId: input.traceId ?? "trace-1", finalResponse: "legacy" }
      : {
          traceId: input.traceId ?? "trace-1",
          startedAtMs: 1000,
          durationMs: 5,
          evalOutputs: input.outputs ?? [{ value: "hello", threadId: "0", tMs: 1 }],
          metrics: { models: ["gpt-4o"] },
        };
    fs.writeFileSync(path.join(inputDir, "agent", "eval-record.json"), JSON.stringify(record));
  }
  return dir;
}

function load(over: Partial<LoadRunArgs> = {}) {
  return loadRun({
    sourceDir,
    source: "agent-v1",
    constantFields: {},
    includeTaskField: true,
    maxBytes: DEFAULT_MAX_INGEST_BYTES,
    reportWarning: (message) => warnings.push(message),
    ...over,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "label-run-"));
  sourceDir = path.join(root, "runs", "proto-news");
  warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("selectLabelingFinalOutput", () => {
  it("selects the last output with its index", () => {
    expect(selectLabelingFinalOutput({ evalOutputs: [{ value: "first" }, { value: "second" }] }))
      .toEqual({ kind: "selected", value: "second", index: 1 });
  });

  it("reports an empty output list as missing", () => {
    expect(selectLabelingFinalOutput({ evalOutputs: [] })).toEqual({ kind: "missing" });
  });

  it("reports a truncated output with its index rather than selecting it", () => {
    expect(selectLabelingFinalOutput({ evalOutputs: [{ value: "big", truncated: true }] }))
      .toEqual({ kind: "truncated", index: 0 });
  });

  it("refuses the legacy finalResponse shape rather than inventing an index", () => {
    expect(selectLabelingFinalOutput({ finalResponse: "legacy" })).toEqual({ kind: "legacy" });
  });

  it("treats a record that is not an object as missing, rather than throwing", () => {
    // `"finalResponse" in "a string"` is a TypeError, which would abort the
    // whole load instead of skipping one broken input.
    expect(selectLabelingFinalOutput("a string")).toEqual({ kind: "missing" });
    expect(selectLabelingFinalOutput(null)).toEqual({ kind: "missing" });
    expect(selectLabelingFinalOutput(42)).toEqual({ kind: "missing" });
  });

  it("distinguishes an ABSENT value from a deliberate JSON null", () => {
    expect(selectLabelingFinalOutput({ evalOutputs: [{}] })).toEqual({ kind: "missing" });
    expect(selectLabelingFinalOutput({ evalOutputs: [{ threadId: "0" }] }))
      .toEqual({ kind: "missing" });
    expect(selectLabelingFinalOutput({ evalOutputs: [{ value: null }] }))
      .toEqual({ kind: "selected", value: null, index: 0 });
  });

  it("treats a non-object output entry as missing", () => {
    expect(selectLabelingFinalOutput({ evalOutputs: [null] })).toEqual({ kind: "missing" });
  });
});

describe("loadRun fields", () => {
  it("builds a task field and an output field by default", () => {
    writeSource([{ inputId: "a" }]);
    expect(load().occurrences[0].fields).toEqual({ task: "do a thing", output: "hello" });
  });

  it("omits the task field when asked", () => {
    writeSource([{ inputId: "a" }]);
    expect(Object.keys(load({ includeTaskField: false }).occurrences[0].fields))
      .toEqual(["output"]);
  });

  it("projects a structured task through the shared rule", () => {
    writeSource([{ inputId: "a", task: { topic: "news" } }]);
    expect(load().occurrences[0].fields.task).toBe('{"topic":"news"}');
  });

  it("projects a structured output as JSON, never [object Object]", () => {
    writeSource([{ inputId: "a", outputs: [{ value: { headline: "x" } }] }]);
    expect(load().occurrences[0].fields.output).toBe('{"headline":"x"}');
  });

  it("lets a constant field replace the run's task when the task field is off", () => {
    writeSource([{ inputId: "a" }]);
    const batch = load({ includeTaskField: false, constantFields: { task: "a better framing" } });
    expect(batch.occurrences[0].fields).toEqual({ task: "a better framing", output: "hello" });
  });

});

describe("loadRun provenance", () => {
  it("records the execution on the occurrence, not in the fields", () => {
    writeSource([{ inputId: "a" }]);
    expect(load().occurrences[0].origin).toMatchObject({
      kind: "run",
      traceId: "trace-1",
      inputId: "a",
      finalOutputIndex: 0,
    });
  });

  it("moves every existing provenance fact onto the run occurrence", () => {
    writeSource([{ inputId: "a", task: { topic: "news" }, outputs: [{ value: { s: 1 } }] }]);
    expect(load().occurrences[0].origin).toMatchObject({
      kind: "run",
      runStartedAtMs: 1000,
      models: ["gpt-4o"],
      agent: { kind: "file", entry: "news.agency" },
      rawTask: { topic: "news" },
      rawValue: { s: 1 },
    });
  });

  it("carries the raw structured output so the projection stays reversible", () => {
    writeSource([{ inputId: "a", outputs: [{ value: { headline: "x" } }] }]);
    const origin = load().occurrences[0].origin;
    expect(origin.kind === "run" && origin.rawValue).toEqual({ headline: "x" });
  });

  it("does not depend on the run directory name", () => {
    writeSource([{ inputId: "a" }]);
    const first = load().occurrences[0];
    const copy = writeSource([{ inputId: "a" }], { dir: path.join(root, "runs", "copied") });
    const second = loadRun({
      sourceDir: copy,
      source: "agent-v1",
      constantFields: {},
      includeTaskField: true,
      maxBytes: DEFAULT_MAX_INGEST_BYTES,
      reportWarning: () => {},
    }).occurrences[0];
    expect(second.fields).toEqual(first.fields);
    expect(second.origin).toEqual(first.origin);
  });

  it("gives two runs with identical output the same fields but distinct origins", () => {
    writeSource([{ inputId: "a" }]);
    const first = load().occurrences[0];
    writeSource([{ inputId: "a", traceId: "trace-2" }]);
    const second = load().occurrences[0];
    expect(second.fields).toEqual(first.fields);
    expect(second.origin).not.toEqual(first.origin);
  });
});

describe("loadRun skips", () => {
  it("skips a failed run", () => {
    writeSource([{ inputId: "a", status: "error" }]);
    const batch = load();
    expect(batch.occurrences).toEqual([]);
    expect(batch.skips).toEqual([{ item: "a", reason: "run-failed" }]);
  });

  it("skips a missing record", () => {
    writeSource([{ inputId: "a", omitRecord: true }]);
    expect(load().skips).toEqual([{ item: "a", reason: "record-unreadable" }]);
  });

  it("skips an input with no recorded output rather than storing a placeholder", () => {
    writeSource([{ inputId: "a", outputs: [] }]);
    expect(load().skips).toEqual([{ item: "a", reason: "no-output" }]);
  });

  it("skips a truncated output and names the environment variable in the description", () => {
    writeSource([{ inputId: "a", outputs: [{ value: "big", truncated: true }] }]);
    const batch = load();
    expect(batch.skips).toEqual([{ item: "a", reason: "truncated-output" }]);
    expect(describeIngestSkip(batch.skips[0])).toMatch(/STATELOG_EVAL_MAX_VALUE_BYTES/);
  });

  it("skips the legacy record shape", () => {
    writeSource([{ inputId: "a", legacyShape: true }]);
    expect(load().skips).toEqual([{ item: "a", reason: "legacy-record" }]);
  });

  it("skips a record with no persisted trace id, because provenance would be unstable", () => {
    writeSource([{ inputId: "a" }]);
    const recordPath = path.join(sourceDir, "inputs", "a", "agent", "eval-record.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.traceId;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    expect(load().skips).toEqual([{ item: "a", reason: "missing-trace-id" }]);
  });

  it("skips an input whose task is not JSON-serialisable data", () => {
    writeSource([{ inputId: "a" }]);
    fs.writeFileSync(path.join(sourceDir, "inputs", "a", "input.json"), JSON.stringify({ id: "a" }));
    expect(load().skips).toEqual([{ item: "a", reason: "invalid-task" }]);
  });

  it("applies the shared eligibility policy to a run's output too", () => {
    writeSource([{ inputId: "a", outputs: [{ value: "x".repeat(50) }] }]);
    expect(load({ maxBytes: 10 }).skips).toEqual([{ item: "a", reason: "too-large" }]);
  });

  it("forwards run-reader warnings to the caller instead of discarding them", () => {
    writeSource([{ inputId: "a" }]);
    fs.writeFileSync(path.join(sourceDir, "inputs", "a", "input.json"), "{ not json");
    load();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("keeps loading after one input is skipped", () => {
    writeSource([{ inputId: "a", status: "error" }, { inputId: "b" }]);
    const batch = load();
    expect(batch.occurrences).toHaveLength(1);
    expect(batch.skips).toHaveLength(1);
  });
});

describe("a malformed record is rejected by the loader, not by the store", () => {
  it("skips a record whose models are not strings", () => {
    // `record` is `any`. Without parsing here, [42] types through as string[]
    // and only fails inside ingest, AFTER the corpus row has been appended —
    // leaving a record with no occurrence behind.
    writeSource([{ inputId: "a" }]);
    const recordPath = path.join(sourceDir, "inputs", "a", "agent", "eval-record.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.metrics = { models: [42] };
    fs.writeFileSync(recordPath, JSON.stringify(record));

    const batch = load();
    expect(batch.occurrences).toEqual([]);
    expect(batch.skips).toEqual([{ item: "a", reason: "record-unreadable" }]);
  });

  it("treats a missing metrics block as no models, which is ordinary", () => {
    writeSource([{ inputId: "a" }]);
    const recordPath = path.join(sourceDir, "inputs", "a", "agent", "eval-record.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.metrics;
    fs.writeFileSync(recordPath, JSON.stringify(record));

    const origin = load().occurrences[0].origin;
    expect(origin.kind === "run" && origin.models).toEqual([]);
  });
});
