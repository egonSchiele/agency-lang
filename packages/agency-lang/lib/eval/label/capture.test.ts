import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureSourceOccurrences, describeCaptureSkip, selectLabelingFinalOutput } from "./capture.js";
import { openCorpusLog } from "./corpus.js";

let root: string;
let storeDir: string;
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

function capture(dir: string = sourceDir) {
  return captureSourceOccurrences({
    sourceDir: dir,
    corpus: openCorpusLog(storeDir),
    reportWarning: (message) => warnings.push(message),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "label-capture-"));
  storeDir = path.join(root, "labels");
  sourceDir = path.join(root, "runs", "proto-news");
  warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("selectLabelingFinalOutput", () => {
  it("selects the last output with its index", () => {
    const selection = selectLabelingFinalOutput({
      evalOutputs: [{ value: "first" }, { value: "second" }],
    });
    expect(selection).toEqual({ kind: "selected", value: "second", text: "second", index: 1 });
  });

  it("projects a structured value as JSON, never [object Object]", () => {
    const selection = selectLabelingFinalOutput({ evalOutputs: [{ value: { headline: "x" } }] });
    expect(selection).toEqual({
      kind: "selected", value: { headline: "x" }, text: '{"headline":"x"}', index: 0,
    });
  });

  it("reports an empty output list as missing", () => {
    expect(selectLabelingFinalOutput({ evalOutputs: [] })).toEqual({ kind: "missing" });
  });

  it("reports a truncated output with its index rather than selecting it", () => {
    const selection = selectLabelingFinalOutput({
      evalOutputs: [{ value: "big", truncated: true }],
    });
    expect(selection).toEqual({ kind: "truncated", index: 0 });
  });

  it("refuses the legacy finalResponse shape rather than inventing an index", () => {
    expect(selectLabelingFinalOutput({ finalResponse: "legacy" })).toEqual({ kind: "legacy" });
  });
});

describe("captureSourceOccurrences", () => {
  it("captures an eligible output", () => {
    writeSource([{ inputId: "a" }]);
    const result = capture();
    expect(result.newlyCaptured).toHaveLength(1);
    expect(result.rows[0].value).toBe("hello");
    expect(result.rows[0].text).toBe("hello");
    expect(result.rows[0].execution).toEqual({ traceId: "trace-1", inputId: "a", finalOutputIndex: 0 });
  });

  it("records provenance without depending on the directory name", () => {
    writeSource([{ inputId: "a" }]);
    const row = capture().rows[0];
    expect(row.provenance.models).toEqual(["gpt-4o"]);
    expect(row.provenance.runStartedAtMs).toBe(1000);
    expect(row.provenance.agent).toEqual({ kind: "file", entry: "news.agency" });
  });

  it("replays an exact existing occurrence and captures nothing new", () => {
    writeSource([{ inputId: "a" }]);
    capture();
    const second = capture();
    expect(second.newlyCaptured).toEqual([]);
    expect(second.rows).toHaveLength(1);
  });

  it("returns rows in source order, mixing replayed and new", () => {
    writeSource([{ inputId: "a" }]);
    capture();
    writeSource([{ inputId: "a" }, { inputId: "b" }]);
    const result = capture();
    expect(result.rows.map((row) => row.input.inputId)).toEqual(["a", "b"]);
    expect(result.newlyCaptured.map((row) => row.input.inputId)).toEqual(["b"]);
  });

  it("treats a copied run directory as the same occurrence, because the trace is the same", () => {
    writeSource([{ inputId: "a" }]);
    capture();
    const copy = writeSource([{ inputId: "a" }], { dir: path.join(root, "runs", "copied") });
    const result = capture(copy);
    expect(result.newlyCaptured).toEqual([]);
  });

  it("treats two runs sharing a basename but not a trace as distinct occurrences", () => {
    writeSource([{ inputId: "a" }], { dir: path.join(root, "one", "proto-news") });
    capture(path.join(root, "one", "proto-news"));
    writeSource([{ inputId: "a", traceId: "trace-2" }], { dir: path.join(root, "two", "proto-news") });
    const result = capture(path.join(root, "two", "proto-news"));
    expect(result.newlyCaptured).toHaveLength(1);
  });

  it("keeps identical content from separate executions as separate occurrences", () => {
    writeSource([{ inputId: "a" }]);
    const first = capture().rows[0];
    writeSource([{ inputId: "a", traceId: "trace-2" }]);
    const second = capture();
    expect(second.newlyCaptured).toHaveLength(1);
    // Same bytes, different execution: one content hash, two occurrences.
    expect(second.newlyCaptured[0].contentHash).toBe(first.contentHash);
    expect(second.newlyCaptured[0].outputId).not.toBe(first.outputId);
  });

  it("throws when an existing output id would be reused with different content", () => {
    writeSource([{ inputId: "a" }]);
    capture();
    writeSource([{ inputId: "a", outputs: [{ value: "changed", threadId: "0", tMs: 1 }] }]);
    expect(() => capture()).toThrow(/different content|conflict/i);
  });

  it("skips a failed run", () => {
    writeSource([{ inputId: "a", status: "error" }]);
    const result = capture();
    expect(result.newlyCaptured).toEqual([]);
    expect(result.skipped).toEqual([{ inputId: "a", reason: "run-failed" }]);
  });

  it("skips a missing record", () => {
    writeSource([{ inputId: "a", omitRecord: true }]);
    expect(capture().skipped).toEqual([{ inputId: "a", reason: "record-unreadable" }]);
  });

  it("skips an input with no recorded output rather than storing a placeholder", () => {
    writeSource([{ inputId: "a", outputs: [] }]);
    const result = capture();
    expect(result.skipped).toEqual([{ inputId: "a", reason: "no-output" }]);
    expect(fs.existsSync(path.join(storeDir, "outputs.jsonl"))).toBe(false);
  });

  it("skips a truncated output and names the environment variable in the description", () => {
    writeSource([{ inputId: "a", outputs: [{ value: "big", truncated: true }] }]);
    const result = capture();
    expect(result.skipped).toEqual([{ inputId: "a", reason: "truncated-output" }]);
    expect(describeCaptureSkip(result.skipped[0])).toMatch(/STATELOG_EVAL_MAX_VALUE_BYTES/);
  });

  it("skips the legacy record shape", () => {
    writeSource([{ inputId: "a", legacyShape: true }]);
    expect(capture().skipped).toEqual([{ inputId: "a", reason: "legacy-record" }]);
  });

  it("skips a record with no persisted trace id, because identity would be unstable", () => {
    writeSource([{ inputId: "a" }]);
    const recordPath = path.join(sourceDir, "inputs", "a", "agent", "eval-record.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    delete record.traceId;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    expect(capture().skipped).toEqual([{ inputId: "a", reason: "missing-trace-id" }]);
  });

  it("skips an input whose task is not JSON-serialisable data", () => {
    writeSource([{ inputId: "a" }]);
    const inputPath = path.join(sourceDir, "inputs", "a", "input.json");
    fs.writeFileSync(inputPath, JSON.stringify({ id: "a" }));
    expect(capture().skipped).toEqual([{ inputId: "a", reason: "invalid-task" }]);
  });

  it("forwards run-reader warnings to the caller instead of discarding them", () => {
    writeSource([{ inputId: "a" }]);
    fs.writeFileSync(path.join(sourceDir, "inputs", "a", "input.json"), "{ not json");
    capture();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("appends every new row before returning", () => {
    writeSource([{ inputId: "a" }, { inputId: "b" }]);
    capture();
    const lines = fs.readFileSync(path.join(storeDir, "outputs.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
