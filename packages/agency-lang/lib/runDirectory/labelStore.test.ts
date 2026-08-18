import * as fs from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeRunDirectory } from "@/eval/runDirectoryFixture.js";

import { completeAnnotation, type ChecklistAnnotation } from "./annotations.js";
import { appendDurably } from "./durableWrite.js";
import { openLabelStore, LAST_MESSAGE_FIELD, type LabelStore } from "./labelStore.js";
import { acquireRunDirLock } from "./lock.js";
import { finishedTraceLines, statelogLine, tempDir } from "./testFixtures.js";

let dir: string;
const warnings: string[] = [];
let store: LabelStore | undefined;

beforeEach(() => {
  warnings.length = 0;
  dir = writeRunDirectory([
    { traceId: "t1", test: { id: "a", input: "write a poem" }, output: "roses are red" },
    { traceId: "t2", test: { id: "b", input: "count to 3" } },
  ]);
});

afterEach(() => {
  store?.close();
  store = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(): LabelStore {
  const lock = acquireRunDirLock({ dir, reportWarning: (message) => warnings.push(message) });
  store = openLabelStore({ dir, lock, reportWarning: (message) => warnings.push(message) });
  return store;
}

describe("items", () => {
  it("projects each trace to its input and output, in statelog order", () => {
    const items = open().items();
    expect(items.map((item) => item.traceId)).toEqual(["t1", "t2"]);
    expect(items[0].fields).toEqual({ input: "write a poem", output: "roses are red" });
  });

  it("omits the output field when the trace recorded none", () => {
    expect(open().items()[1].fields).toEqual({ input: "count to 3" });
  });

  it("shows the last assistant message, clearly marked, when there is no output", () => {
    const lines = [
      statelogLine("t3", "agentStart", { entryNode: "main", args: {}, input: "chat" }),
      statelogLine("t3", "promptCompletion", { model: "m", completion: "hello there" }),
      statelogLine("t3", "agentEnd", { timeTaken: 1 }),
    ];
    appendDurably(path.join(dir, "statelog.jsonl"), lines.join("\n") + "\n");
    const item = open()
      .items()
      .find((entry) => entry.traceId === "t3");
    expect(item?.fields.output).toBeUndefined();
    expect(item?.fields[LAST_MESSAGE_FIELD]).toMatch(/^\(no recorded output/);
    expect(item?.fields[LAST_MESSAGE_FIELD]).toContain("hello there");
  });
});

describe("appendAnnotation", () => {
  const HASH = `sha256:${"0".repeat(64)}`;

  function row(traceId: string): ChecklistAnnotation {
    return completeAnnotation(
      {
        traceId,
        annotator: { kind: "human", id: "adit" },
        kind: "checklist",
        checklist: "cl_x",
        version: 1,
        hash: HASH,
        answers: { q_a: true },
        note: "",
      },
      "2026-08-18T00:00:00.000Z",
    ) as ChecklistAnnotation;
  }

  it("refuses a trace the directory does not hold", () => {
    expect(() => open().appendAnnotation(row("nope"))).toThrow(/not in/);
  });

  it("refuses a row whose revision is not on disk", () => {
    expect(() => open().appendAnnotation(row("t1"))).toThrow(/revision not found/i);
  });
});

describe("validation at open", () => {
  it("refuses a checklist row that names a revision that does not exist", () => {
    const HASH = `sha256:${"0".repeat(64)}`;
    const line = JSON.stringify(
      completeAnnotation(
        {
          traceId: "t1",
          annotator: { kind: "human", id: "adit" },
          kind: "checklist",
          checklist: "cl_missing",
          version: 1,
          hash: HASH,
          answers: {},
          note: "",
        },
        "2026-08-18T00:00:00.000Z",
      ),
    );
    appendDurably(path.join(dir, "annotations.jsonl"), line + "\n");
    expect(() => open()).toThrow(/cl_missing@1, which is missing/);
  });

  it("opens an empty directory with no traces", () => {
    fs.rmSync(dir, { recursive: true, force: true });
    dir = tempDir("empty-");
    fs.mkdirSync(dir, { recursive: true });
    expect(open().items()).toEqual([]);
  });

  it("does not need a statelog to be finished traces only", () => {
    // A trace with no agentEnd is still a trace someone may want to judge.
    appendDurably(
      path.join(dir, "statelog.jsonl"),
      finishedTraceLines("t4", { input: "x" }).slice(0, 1).join("\n") + "\n",
    );
    expect(
      open()
        .items()
        .map((item) => item.traceId),
    ).toContain("t4");
  });
});
