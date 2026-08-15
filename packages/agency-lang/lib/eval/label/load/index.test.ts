import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadBatch, type IngestRequest, type LoadDependencies } from "./index.js";
import { DEFAULT_MAX_INGEST_BYTES, type LoadedBatch } from "./types.js";

let root: string;

const emptyBatch: LoadedBatch = { occurrences: [], skips: [] };

type Calls = {
  run: unknown[];
  files: unknown[];
  json: unknown[];
  statelog: unknown[];
  selection: unknown[];
};

function spies(): { calls: Calls; dependencies: LoadDependencies } {
  const calls: Calls = { run: [], files: [], json: [], statelog: [], selection: [] };
  return {
    calls,
    dependencies: {
      loadRun: (args) => {
        calls.run.push(args);
        return emptyBatch;
      },
      loadFiles: (args) => {
        calls.files.push(args);
        return emptyBatch;
      },
      loadJsonArray: (args) => {
        calls.json.push(args);
        return emptyBatch;
      },
      loadStatelog: (args) => {
        calls.statelog.push(args);
        return emptyBatch;
      },
      resolveFileSelection: (source, recursive) => {
        calls.selection.push({ source, recursive });
        return { root: path.resolve(source), files: [] };
      },
    } as LoadDependencies,
  };
}

function request(over: Partial<IngestRequest> = {}): IngestRequest {
  return {
    source: {
      path: root,
      requestedFormat: "auto",
      includeTaskField: true,
      recursive: false,
    },
    sourceName: "agent-v1",
    constantFields: {},
    maxBytes: DEFAULT_MAX_INGEST_BYTES,
    selection: { kind: "none" },
    reportWarning: () => {},
    ...over,
  };
}

function makeRunDir(): string {
  const dir = path.join(root, "run");
  fs.mkdirSync(path.join(dir, "inputs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), "{}");
  return dir;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "label-loadbatch-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadBatch dispatch", () => {
  it("calls exactly one loader for a run source", () => {
    const { calls, dependencies } = spies();
    loadBatch(request({
      source: { path: makeRunDir(), requestedFormat: "auto", includeTaskField: true, recursive: false },
    }), dependencies);
    expect(calls.run).toHaveLength(1);
    expect(calls.files).toHaveLength(0);
    expect(calls.json).toHaveLength(0);
  });

  it("calls exactly one loader for a files source", () => {
    const { calls, dependencies } = spies();
    loadBatch(request(), dependencies);
    expect(calls.files).toHaveLength(1);
    expect(calls.run).toHaveLength(0);
  });

  it("calls exactly one loader for a json source", () => {
    fs.writeFileSync(path.join(root, "answers.json"), "[]");
    const { calls, dependencies } = spies();
    loadBatch(request({
      source: {
        path: path.join(root, "answers.json"),
        requestedFormat: "auto",
        includeTaskField: true,
        recursive: false,
      },
    }), dependencies);
    expect(calls.json).toHaveLength(1);
    expect(calls.files).toHaveLength(0);
  });
});

describe("loadBatch normalizes loader arguments", () => {
  it("passes the run's task-field choice through", () => {
    const { calls, dependencies } = spies();
    loadBatch(request({
      source: { path: makeRunDir(), requestedFormat: "run", includeTaskField: false, recursive: false },
    }), dependencies);
    expect(calls.run[0]).toMatchObject({ includeTaskField: false, source: "agent-v1" });
  });

  it("resolves a file selection before calling the files loader", () => {
    const { calls, dependencies } = spies();
    loadBatch(request({
      source: { path: root, requestedFormat: "files", includeTaskField: true, recursive: true },
    }), dependencies);
    expect(calls.selection[0]).toEqual({ source: root, recursive: true });
    expect(calls.files[0]).toMatchObject({ selection: { root } });
  });

  it("derives a json itemKey from the document name, not its full path", () => {
    // A full path would change the occurrence identity when the same file is
    // ingested from a different working directory.
    fs.writeFileSync(path.join(root, "answers.json"), "[]");
    const { calls, dependencies } = spies();
    loadBatch(request({
      source: {
        path: path.join(root, "answers.json"),
        requestedFormat: "json",
        includeTaskField: true,
        recursive: false,
      },
    }), dependencies);
    expect(calls.json[0]).toMatchObject({ itemKey: "answers.json" });
  });

  it("passes constant fields and the byte cap to every loader", () => {
    const { calls, dependencies } = spies();
    loadBatch(request({ constantFields: { task: "t" }, maxBytes: 99 }), dependencies);
    expect(calls.files[0]).toMatchObject({ constantFields: { task: "t" }, maxBytes: 99 });
  });

  it("rejects a json source that does not exist", () => {
    const { dependencies } = spies();
    expect(() => loadBatch(request({
      source: {
        path: path.join(root, "missing.json"),
        requestedFormat: "json",
        includeTaskField: true,
        recursive: false,
      },
    }), dependencies)).toThrow(/not found/);
  });
});

describe("constant fields cannot collide with a loader's own fields", () => {
  it("rejects a constant output for an auto-detected files source", () => {
    // The blocking case: with `auto` the CLI does not know which loader will
    // run, so this check has to live here. The loader's value wins on merge, so
    // the constant would otherwise vanish and change the stored record.
    const { dependencies } = spies();
    expect(() => loadBatch(request({ constantFields: { output: "constant" } }), dependencies))
      .toThrow(/already produces "output"/);
  });

  it("rejects a constant task for an auto-detected run source", () => {
    const { dependencies } = spies();
    expect(() => loadBatch(request({
      source: { path: makeRunDir(), requestedFormat: "auto", includeTaskField: true, recursive: false },
      constantFields: { task: "constant" },
    }), dependencies)).toThrow(/Pass --no-task-field/);
  });

  it("rejects a constant output for an auto-detected json source", () => {
    fs.writeFileSync(path.join(root, "answers.json"), "[]");
    const { dependencies } = spies();
    expect(() => loadBatch(request({
      source: {
        path: path.join(root, "answers.json"),
        requestedFormat: "auto",
        includeTaskField: true,
        recursive: false,
      },
      constantFields: { output: "constant" },
    }), dependencies)).toThrow(/already produces "output"/);
  });

  it("allows replacing a run's task with the explicit combination", () => {
    const { calls, dependencies } = spies();
    loadBatch(request({
      source: { path: makeRunDir(), requestedFormat: "auto", includeTaskField: false, recursive: false },
      constantFields: { task: "a better framing" },
    }), dependencies);
    expect(calls.run).toHaveLength(1);
  });

  it("allows a constant field no loader produces", () => {
    const { calls, dependencies } = spies();
    loadBatch(request({ constantFields: { task: "Summarize" } }), dependencies);
    expect(calls.files).toHaveLength(1);
  });

  it("names the resolved format in the message, not the requested one", () => {
    const { dependencies } = spies();
    expect(() => loadBatch(request({ constantFields: { output: "x" } }), dependencies))
      .toThrow(/files loader/);
  });
});

describe("statelog dispatch", () => {
  function makeStatelogFile(): string {
    const file = path.join(root, "log.jsonl");
    fs.writeFileSync(file, JSON.stringify({ format_version: 1, trace_id: "A", data: { type: "agentStart" } }) + "\n");
    return file;
  }

  it("routes an auto-detected statelog file to loadStatelog with the trace ids", () => {
    const { calls, dependencies } = spies();
    loadBatch(request({
      source: { path: makeStatelogFile(), requestedFormat: "auto", includeTaskField: true, recursive: false },
      selection: { kind: "statelog", request: { traceIds: ["A"] } },
    }), dependencies);
    expect(calls.statelog).toHaveLength(1);
    expect(calls.statelog[0]).toMatchObject({ traceIds: ["A"] });
  });

  it("rejects a statelog selection on a non-statelog source", () => {
    const { dependencies } = spies();
    expect(() => loadBatch(request({
      selection: { kind: "statelog", request: { traceIds: ["A"] } },
    }), dependencies)).toThrow(/only applies to a statelog source/);
  });
});
