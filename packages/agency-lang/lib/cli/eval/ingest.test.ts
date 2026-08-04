import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoadedBatch } from "@/eval/label/load/types.js";

import {
  evalIngest,
  parseFieldArgs,
  type EvalIngestDependencies,
  type EvalIngestOptions,
} from "./ingest.js";

let root: string;
let storeDir: string;
const reported: string[] = [];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "label-ingest-cli-")));
  storeDir = path.join(root, "labels");
  reported.length = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function batchOf(count: number, skips: LoadedBatch["skips"] = []): LoadedBatch {
  return {
    occurrences: Array.from({ length: count }, (_unused, index) => ({
      fields: { output: `answer ${index}` },
      source: "handwritten",
      origin: { kind: "file" as const, itemKey: `${index}.txt` },
    })),
    skips,
    discoveredFieldNames: ["output"],
  };
}

function dependencies(over: Partial<EvalIngestDependencies> = {}): EvalIngestDependencies {
  return {
    loadBatch: vi.fn(() => batchOf(1)) as never,
    openStore: vi.fn(() => ({
      ingest: () => ({
        recordsAdded: 1,
        recordsReplayed: 0,
        occurrencesAdded: 1,
        occurrencesReplayed: 0,
        skips: [],
        newFieldNames: [],
      }),
      close: () => {},
    })) as never,
    report: (message) => reported.push(message),
    ...over,
  };
}

function options(over: Partial<EvalIngestOptions> = {}): EvalIngestOptions {
  return { path: root, source: "handwritten", store: storeDir, ...over };
}

describe("parseFieldArgs", () => {
  it("returns an empty map when nothing was given", () => {
    expect(parseFieldArgs({})).toEqual({});
  });

  it("parses a single field", () => {
    expect(parseFieldArgs({ field: ["task=Summarize"] })).toEqual({ task: "Summarize" });
  });

  it("splits only on the FIRST = so a value may contain one", () => {
    expect(parseFieldArgs({ field: ["note=a=b"] })).toEqual({ note: "a=b" });
  });

  it("treats --task as sugar for --field task=", () => {
    expect(parseFieldArgs({ task: "Summarize" })).toEqual({ task: "Summarize" });
  });

  it("rejects --task together with --field task=", () => {
    expect(() => parseFieldArgs({ task: "A", field: ["task=B"] }))
      .toThrow(/--task is sugar for --field task=/);
  });

  it("rejects the same --field name twice, rather than letting the last one win", () => {
    expect(() => parseFieldArgs({ field: ["a=1", "a=2"] })).toThrow(/given twice/);
  });

  it("rejects a --field with no =", () => {
    expect(() => parseFieldArgs({ field: ["broken"] })).toThrow(/name=value/);
  });

  it("rejects a --field with an empty name", () => {
    expect(() => parseFieldArgs({ field: ["=value"] })).toThrow(/name=value/);
  });

  it("accepts an empty value, which is a deliberate blank field", () => {
    expect(parseFieldArgs({ field: ["note="] })).toEqual({ note: "" });
  });
});

describe("parseFieldArgs field names", () => {
  it("rejects __proto__, which would set the prototype instead of a key", () => {
    // On a normal object this assignment creates no own property, so a
    // duplicate check would miss it and the failure would surface later as a
    // confusing schema error deep inside ingest.
    expect(() => parseFieldArgs({ field: ["__proto__=x"] })).toThrow(/not a valid field name/);
  });

  it("rejects a name the store's schema would refuse", () => {
    expect(() => parseFieldArgs({ field: ["Output=x"] })).toThrow(/not a valid field name/);
    expect(() => parseFieldArgs({ field: ["2nd=x"] })).toThrow(/not a valid field name/);
    expect(() => parseFieldArgs({ field: ["bad{name}=x"] })).toThrow(/not a valid field name/);
  });

  it("accumulates into a null-prototype object, so nothing is inherited", () => {
    const fields = parseFieldArgs({ field: ["note=x"] });
    expect(Object.getPrototypeOf(fields)).toBeNull();
  });
});

describe("evalIngest", () => {
  it("requires --source, because an occurrence with no batch name is untraceable", async () => {
    await expect(evalIngest(options({ source: undefined }), dependencies()))
      .rejects.toThrow(/--source is required/);
  });

  it("rejects a blank --source", async () => {
    await expect(evalIngest(options({ source: "   " }), dependencies()))
      .rejects.toThrow(/--source is required/);
  });

  it("rejects extra positional arguments, which mean the shell expanded a glob", async () => {
    await expect(evalIngest(options({ extraArgs: ["b.txt", "c.txt"] }), dependencies()))
      .rejects.toThrow(/Quote the pattern/);
  });

  it("rejects an unknown --format", async () => {
    await expect(evalIngest(options({ format: "csv" }), dependencies()))
      .rejects.toThrow(/Unknown --format/);
  });

  it("errors when a source yields zero records rather than succeeding quietly", async () => {
    // A silent zero-record success is how you end up labelling an empty store
    // and wondering where everything went.
    const deps = dependencies({ loadBatch: vi.fn(() => batchOf(0)) as never });
    await expect(evalIngest(options(), deps)).rejects.toThrow(/No records to ingest/);
  });

  it("explains WHY nothing was ingested when everything was skipped", async () => {
    const deps = dependencies({
      loadBatch: vi.fn(() => batchOf(0, [{ item: "a.txt", reason: "empty" }])) as never,
    });
    await expect(evalIngest(options(), deps)).rejects.toThrow(/a\.txt/);
  });

  it("passes a declarative request to loadBatch and never picks a loader itself", async () => {
    const loadBatch = vi.fn(() => batchOf(1));
    await evalIngest(
      options({ format: "files", recursive: true, task: "Summarize", maxBytes: 99 }),
      dependencies({ loadBatch: loadBatch as never }),
    );
    expect(loadBatch).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        path: root,
        requestedFormat: "files",
        recursive: true,
      }),
      sourceName: "handwritten",
      constantFields: { task: "Summarize" },
      maxBytes: 99,
    }));
  });

  it("passes --no-task-field through as includeTaskField false", async () => {
    const loadBatch = vi.fn(() => batchOf(1));
    await evalIngest(
      options({ format: "run", taskField: false }),
      dependencies({ loadBatch: loadBatch as never }),
    );
    expect(loadBatch).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ includeTaskField: false }),
    }));
  });

  it("prints added, replayed and occurrence counts", async () => {
    await evalIngest(options(), dependencies());
    const printed = reported.join("\n");
    expect(printed).toContain("1 new record");
    expect(printed).toContain("1 new occurrence");
  });

  it("prints one line per skip, naming the item", async () => {
    const deps = dependencies({
      openStore: vi.fn(() => ({
        ingest: () => ({
          recordsAdded: 1,
          recordsReplayed: 0,
          occurrencesAdded: 1,
          occurrencesReplayed: 0,
          skips: [{ item: "bad.txt", reason: "empty" as const }],
          newFieldNames: [],
        }),
        close: () => {},
      })) as never,
    });
    await evalIngest(options(), deps);
    expect(reported.join("\n")).toContain("bad.txt");
  });

  it("warns about an unseen field name without refusing the ingest", async () => {
    const deps = dependencies({
      openStore: vi.fn(() => ({
        ingest: () => ({
          recordsAdded: 1,
          recordsReplayed: 0,
          occurrencesAdded: 1,
          occurrencesReplayed: 0,
          skips: [],
          newFieldNames: ["response"],
        }),
        close: () => {},
      })) as never,
    });
    await expect(evalIngest(options(), deps)).resolves.toBeUndefined();
    expect(reported.join("\n")).toContain("response");
  });

  it("releases the store lock even when ingesting throws", async () => {
    const deps = dependencies({
      openStore: vi.fn(() => ({
        ingest: () => {
          throw new Error("boom");
        },
        close: () => {},
      })) as never,
    });
    await expect(evalIngest(options(), deps)).rejects.toThrow("boom");
    expect(fs.existsSync(path.join(storeDir, ".lock"))).toBe(false);
  });
});
