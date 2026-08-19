import * as fs from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeDefinition } from "@/eval/label/checklist.js";
import { LAST_MESSAGE_FIELD, resolveLabelingGroup } from "@/eval/label/group.js";
import type { ChecklistRevision } from "@/eval/label/types.js";
import { writeRunGroup } from "@/eval/runDirectoryFixture.js";

import { completeAnnotation, type ChecklistAnnotation } from "./annotations.js";
import { appendDurably } from "./durableWrite.js";
import {
  openLabelStore,
  type LabelSessionIdentity,
  type LabelStore,
  type OpenLabelStoreArgs,
} from "./labelStore.js";
import { recordGradingPass } from "./mutations.js";
import { readRunDirectory, runDirPaths } from "./runDir.js";
import { finishedTraceLines, statelogLine } from "./testFixtures.js";

/** A group of two runs: `a` holds t1 (finished, with output), `b` holds t2 (no output). */
let group: string;
const warnings: string[] = [];
const stores: LabelStore[] = [];
const quiet = { reportWarning: (message: string) => warnings.push(message) };

beforeEach(() => {
  warnings.length = 0;
  group = writeRunGroup([
    { traceId: "t1", test: { id: "a", input: "write a poem" }, output: "roses are red" },
    { traceId: "t2", test: { id: "b", input: "count to 3" } },
  ]);
});

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
  fs.rmSync(group, { recursive: true, force: true });
});

const adit = { kind: "human" as const, id: "adit" };
const SESSION_ONE = `session_${"1".repeat(64)}`;
const SESSION_TWO = `session_${"2".repeat(64)}`;

function identity(over: Partial<LabelSessionIdentity> = {}): LabelSessionIdentity {
  return { sessionId: SESSION_ONE, checklistId: "cl_x", annotator: adit, ...over };
}

function open(over: Partial<OpenLabelStoreArgs> = {}): LabelStore {
  const store = openLabelStore({
    group: resolveLabelingGroup([group], quiet),
    identity: identity(),
    ...quiet,
    ...over,
  });
  stores.push(store);
  return store;
}

/** Publish a one-question checklist `cl_x` through the store, as a session would. */
function publish(store: LabelStore): ChecklistRevision {
  const definition = normalizeDefinition({
    checklistId: "cl_x",
    name: "quality",
    questions: [{ id: "q_a", text: "Accurate?" }],
  });
  const prepared = store.prepareChecklist(definition);
  if (prepared.kind !== "publish") throw new Error(prepared.kind);
  const definitionPath = path.join(group, "quality.json");
  fs.writeFileSync(definitionPath, JSON.stringify(definition));
  return store.publishRevision(prepared.pending, definitionPath).revision;
}

function row(
  traceId: string,
  revision: ChecklistRevision,
  over: Partial<ChecklistAnnotation> = {},
) {
  return completeAnnotation(
    {
      traceId,
      annotator: adit,
      sessionId: SESSION_ONE,
      kind: "checklist",
      checklist: revision.checklistId,
      version: revision.version,
      hash: revision.hash,
      answers: { q_a: true },
      note: "",
      ...over,
    },
    "2026-08-18T00:00:00.000Z",
  ) as ChecklistAnnotation;
}

function lockFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".lock")) out.push(path.relative(group, full));
    }
  };
  walk(group);
  return out.sort();
}

describe("items", () => {
  it("projects each run to its directory, trace, input and output, in walk order", () => {
    const items = open().items();
    expect(items.map((item) => [path.basename(item.runDir), item.traceId])).toEqual([
      ["a", "t1"],
      ["b", "t2"],
    ]);
    expect(items[0].fields).toEqual({ input: "write a poem", output: "roses are red" });
    expect(items[1].fields).toEqual({ input: "count to 3" });
  });

  it("shows the last assistant message, clearly marked, when there is no output", () => {
    const c = path.join(group, "c");
    fs.mkdirSync(c);
    const lines = [
      statelogLine("t3", "agentStart", { entryNode: "main", args: {}, input: "chat" }),
      statelogLine("t3", "promptCompletion", { model: "m", completion: "hello there" }),
      statelogLine("t3", "agentEnd", { timeTaken: 1 }),
    ];
    fs.writeFileSync(path.join(c, "statelog.jsonl"), lines.join("\n") + "\n");
    const item = open()
      .items()
      .find((entry) => entry.traceId === "t3");
    expect(item?.fields.output).toBeUndefined();
    expect(item?.fields[LAST_MESSAGE_FIELD]).toMatch(/^\(no recorded output/);
    expect(item?.fields[LAST_MESSAGE_FIELD]).toContain("hello there");
  });

  it("includes a run whose trace never finished", () => {
    const c = path.join(group, "c");
    fs.mkdirSync(c);
    fs.writeFileSync(
      path.join(c, "statelog.jsonl"),
      finishedTraceLines("t4", { input: "x" }).slice(0, 1).join("\n") + "\n",
    );
    expect(
      open()
        .items()
        .map((item) => item.traceId),
    ).toContain("t4");
  });
});

describe("appendAnnotation", () => {
  it("lands in the named run's annotations.jsonl and nowhere else, and is idempotent", () => {
    const store = open();
    const revision = publish(store);
    expect(store.appendAnnotation(row("t2", revision))).toBe("appended");
    expect(store.appendAnnotation(row("t2", revision))).toBe("replayed");
    const a = readRunDirectory(path.join(group, "a"), quiet);
    const b = readRunDirectory(path.join(group, "b"), quiet);
    expect(b.annotationRows.filter((r) => r.kind === "checklist")).toHaveLength(1);
    expect(a.annotationRows.filter((r) => r.kind === "checklist")).toHaveLength(0);
    expect(fs.existsSync(path.join(group, "annotations.jsonl"))).toBe(false);
  });

  it("updates the cached snapshot from the mutation, so readSession sees the judgement", () => {
    const store = open();
    const revision = publish(store);
    store.appendAnnotation(row("t1", revision));
    expect(Object.keys(store.readSession().judgements)).toEqual(["t1"]);
  });

  it("holds the run's lock only around the append: another writer gets in between", () => {
    const store = open();
    const revision = publish(store);
    store.appendAnnotation(row("t1", revision));
    expect(() =>
      recordGradingPass({
        dir: path.join(group, "a"),
        scores: [
          {
            traceId: "t1",
            annotator: { kind: "grader", id: "g@1" },
            name: "g",
            score: { kind: "binary", pass: true },
            weight: 1,
            mustPass: false,
          },
        ],
      }),
    ).not.toThrow();
    expect(store.appendAnnotation(row("t1", revision, { note: "again" }))).toBe("appended");
  });

  it("refuses a trace outside the session", () => {
    const store = open();
    const revision = publish(store);
    expect(() => store.appendAnnotation(row("nope", revision))).toThrow(/not in this session/);
  });

  it("refuses a row whose revision is not in the group's lineage", () => {
    const store = open();
    const fake: ChecklistRevision = {
      schemaVersion: 1,
      parentVersion: null,
      checklistId: "cl_x",
      version: 1,
      hash: `sha256:${"0".repeat(64)}`,
      name: "q",
      questions: [],
      createdAt: "2026-08-18T00:00:00.000Z",
    };
    expect(() => store.appendAnnotation(row("t1", fake))).toThrow(/missing from/);
    expect(fs.existsSync(runDirPaths(path.join(group, "a")).annotations)).toBe(true);
    expect(
      readRunDirectory(path.join(group, "a"), quiet).annotationRows.filter(
        (r) => r.kind === "checklist",
      ),
    ).toHaveLength(0);
  });
});

describe("where session files live", () => {
  it("revisions and drafts are written under <group>/checklists/<id>/", () => {
    const store = open();
    const revision = publish(store);
    const lineage = path.join(group, "checklists", revision.checklistId);
    expect(fs.existsSync(path.join(lineage, "1.json"))).toBe(true);
    expect(fs.existsSync(path.join(lineage, "current.json"))).toBe(true);
    store.saveDraft({
      schemaVersion: 1,
      sessionId: SESSION_ONE,
      binding: {
        traceIds: ["t1", "t2"],
        checklistId: "cl_x",
        checklist: { kind: "published", version: 1, hash: revision.hash },
        annotator: adit,
      },
      currentIndex: 0,
      answersByTraceId: {},
      notesByTraceId: {},
      reviewedByTraceId: {},
      stagedQuestions: null,
      pendingRevision: null,
      pendingAnnotation: null,
      activeMsByTraceId: {},
    });
    expect(fs.existsSync(path.join(lineage, "drafts", `${SESSION_ONE}.json`))).toBe(true);
    expect(store.readSession().draft?.sessionId).toBe(SESSION_ONE);
    for (const run of ["a", "b"]) {
      expect(fs.existsSync(path.join(group, run, "checklists"))).toBe(false);
    }
  });
});

describe("locks", () => {
  it("holds one lock per session draft while open, and none after close", () => {
    const store = open();
    expect(lockFiles()).toEqual([`checklists/cl_x/drafts/${SESSION_ONE}.lock`]);
    store.close();
    expect(lockFiles()).toEqual([]);
    store.close(); // idempotent
  });

  it("refuses a second store on the same session; a different annotator opens beside it", () => {
    open();
    expect(() => open()).toThrow(/Another writer holds .*session_1+\.lock/);
    expect(() =>
      open({ identity: identity({ sessionId: SESSION_TWO, annotator: { ...adit, id: "sam" } }) }),
    ).not.toThrow();
    expect(lockFiles()).toEqual([
      `checklists/cl_x/drafts/${SESSION_ONE}.lock`,
      `checklists/cl_x/drafts/${SESSION_TWO}.lock`,
    ]);
  });

  it("releases the session lock when opening fails validation", () => {
    const bad = completeAnnotation(
      {
        traceId: "t1",
        annotator: adit,
        kind: "checklist",
        checklist: "cl_missing",
        version: 1,
        hash: `sha256:${"0".repeat(64)}`,
        answers: {},
        note: "",
      },
      "2026-08-18T00:00:00.000Z",
    );
    appendDurably(path.join(group, "a", "annotations.jsonl"), JSON.stringify(bad) + "\n");
    expect(() => open()).toThrow(/cl_missing@1, which is missing/);
    expect(lockFiles()).toEqual([]);
  });

  it("two sessions racing to publish the same lineage: the stale one loses, the lineage is intact", () => {
    const first = open();
    const second = open({ identity: identity({ sessionId: SESSION_TWO }) });
    const definition = normalizeDefinition({
      checklistId: "cl_x",
      name: "quality",
      questions: [{ id: "q_a", text: "Accurate?" }],
    });
    const definitionPath = path.join(group, "quality.json");
    fs.writeFileSync(definitionPath, JSON.stringify(definition));
    const preparedFirst = first.prepareChecklist(definition);
    const preparedSecond = second.prepareChecklist({
      ...definition,
      questions: [{ id: "q_b", text: "On time?", weight: 1, deleted: false }],
    });
    if (preparedFirst.kind !== "publish" || preparedSecond.kind !== "publish") throw new Error();
    first.publishRevision(preparedFirst.pending, definitionPath);
    expect(() => second.publishRevision(preparedSecond.pending, definitionPath)).toThrow(
      /lineage moved|already exists with different content/,
    );
    const lineage = path.join(group, "checklists", "cl_x");
    expect(fs.readdirSync(lineage).filter((name) => /^\d+\.json$/.test(name))).toEqual(["1.json"]);
    expect(lockFiles()).toEqual([
      `checklists/cl_x/drafts/${SESSION_ONE}.lock`,
      `checklists/cl_x/drafts/${SESSION_TWO}.lock`,
    ]);
    // The loser reconciles against the published lineage (the synced file).
    const synced = normalizeDefinition(JSON.parse(fs.readFileSync(definitionPath, "utf8")));
    expect(second.prepareChecklist(synced).kind).toBe("current");
  });
});

describe("validation at open", () => {
  it("names the run whose row points at a revision that does not exist", () => {
    const bad = completeAnnotation(
      {
        traceId: "t2",
        annotator: adit,
        kind: "checklist",
        checklist: "cl_missing",
        version: 1,
        hash: `sha256:${"0".repeat(64)}`,
        answers: {},
        note: "",
      },
      "2026-08-18T00:00:00.000Z",
    );
    appendDurably(path.join(group, "b", "annotations.jsonl"), JSON.stringify(bad) + "\n");
    expect(() => open()).toThrow(
      new RegExp(`${path.join(group, "b")}.*cl_missing@1, which is missing`),
    );
  });
});
