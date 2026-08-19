import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  annotationId,
  completeAnnotation,
  annotatorLineage,
  foldAnnotations,
  readAnnotations,
  type Annotation,
  type AnnotationDraft,
} from "./annotations.js";

const human = { kind: "human" as const, id: "adit" };
const grader = (revision: string) => ({ kind: "grader" as const, id: `graders.ts@${revision}` });

/** A checklist sign-off carrying only a note: the smallest human-written row. */
function signOff(traceId: string, text: string): AnnotationDraft {
  return {
    traceId,
    annotator: human,
    kind: "checklist",
    checklist: "news",
    version: 1,
    hash: "sha256:a",
    answers: {},
    note: text,
  };
}

function score(
  passId: string,
  name: string,
  value: number,
  options: { passSize?: number; annotator?: Annotation["annotator"] } = {},
): AnnotationDraft {
  return {
    traceId: "t1",
    annotator: options.annotator ?? grader("aaa"),
    kind: "score",
    passId,
    passSize: options.passSize ?? 1,
    name,
    score: { kind: "scalar", value },
    weight: 1,
    mustPass: false,
  };
}

let clock = 0;
function row(draft: AnnotationDraft): Annotation {
  clock += 1;
  return completeAnnotation(draft, `2026-08-18T00:00:${String(clock).padStart(2, "0")}Z`);
}

describe("annotationId", () => {
  it("is deterministic and depends on the payload", () => {
    expect(annotationId(signOff("t1", "slow"))).toBe(annotationId(signOff("t1", "slow")));
    expect(annotationId(signOff("t1", "slow"))).not.toBe(annotationId(signOff("t1", "fast")));
    expect(annotationId(signOff("t1", "slow"))).not.toBe(annotationId(signOff("t2", "slow")));
  });

  it("differs per pass for otherwise identical scores", () => {
    expect(annotationId(score("pass_1", "cheap", 1))).not.toBe(
      annotationId(score("pass_2", "cheap", 1)),
    );
  });

  it("ignores createdAt", () => {
    const first = row(signOff("t1", "x"));
    const second = row(signOff("t1", "x"));
    expect(first.id).toBe(second.id);
    expect(first.createdAt).not.toBe(second.createdAt);
  });
});

describe("foldAnnotations", () => {
  it("collects the run row per trace, and has no slot for free-form notes (those are notes.md)", () => {
    const run: AnnotationDraft = {
      traceId: "t1",
      annotator: { kind: "harness", id: "eval" },
      kind: "run",
      test: { id: "a", input: "hi" },
      suite: null,
      ended: "ok",
      flags: {},
    };
    const folded = foldAnnotations([row(run)]);
    expect(folded.t1.run?.kind).toBe("run");
    expect(Object.keys(folded.t1)).toEqual(["scores", "gradingPasses", "checklists", "run"]);
  });

  it("folds checklist answers per question in append order, keyed per annotator", () => {
    const first: AnnotationDraft = {
      traceId: "t1",
      annotator: human,
      kind: "checklist",
      checklist: "news",
      version: 1,
      hash: "sha256:a",
      answers: { q_a: true, q_b: false },
      note: "",
    };
    const second: AnnotationDraft = { ...first, version: 2, answers: { q_b: true } };
    const other: AnnotationDraft = {
      ...first,
      annotator: { kind: "human", id: "sam" },
      answers: { q_a: false },
    };
    const folded = foldAnnotations([row(first), row(second), row(other)]);
    expect(folded.t1.checklists["news:human:adit"].answers).toEqual({ q_a: true, q_b: true });
    expect(folded.t1.checklists["news:human:sam"].answers).toEqual({ q_a: false });
  });

  it("takes the latest complete score pass; a new revision of the same grader supersedes, and passes are counted", () => {
    const rows = [
      row(score("pass_1", "cheap", 0.2)),
      row(score("pass_2", "cheap", 0.9)),
      row(score("pass_3", "cheap", 0.5, { annotator: grader("bbb") })),
      row(score("pass_4", "fast", 0.1, { annotator: { kind: "judge", id: "goal-judge@1" } })),
      row(score("pass_5", "fast", 0.3, { annotator: { kind: "judge", id: "goal-judge@2" } })),
    ];
    const folded = foldAnnotations(rows);
    expect(Object.keys(folded.t1.scores).sort()).toEqual([
      "grader:graders.ts:cheap",
      "judge:goal-judge:fast",
    ]);
    expect(folded.t1.scores["grader:graders.ts:cheap"].id).toBe(rows[2].id);
    expect(folded.t1.scores["judge:goal-judge:fast"].id).toBe(rows[4].id);
    expect(folded.t1.gradingPasses).toBe(5);
  });

  it("annotatorLineage strips the revision and leaves ids without one alone", () => {
    expect(annotatorLineage("goal-judge@1")).toBe("goal-judge");
    expect(annotatorLineage("graders.ts@abc")).toBe("graders.ts");
    expect(annotatorLineage("inline:cheap")).toBe("inline:cheap");
    expect(annotatorLineage("@odd")).toBe("@odd");
  });

  it("ignores a pass that never completed", () => {
    const rows = [
      row(score("pass_1", "cheap", 0.2)),
      // pass_2 expects two rows but only one landed
      row(score("pass_2", "cheap", 0.9, { passSize: 2 })),
    ];
    const folded = foldAnnotations(rows);
    expect(folded.t1.scores["grader:graders.ts:cheap"].id).toBe(rows[0].id);
    expect(folded.t1.gradingPasses).toBe(1);
  });
});

describe("readAnnotations", () => {
  function file(text: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ann-"));
    const target = path.join(dir, "annotations.jsonl");
    fs.writeFileSync(target, text);
    return target;
  }

  it("skips a malformed middle row with a warning and ignores a torn last line", () => {
    const good = row(signOff("t1", "ok"));
    const text =
      JSON.stringify(good) +
      "\n" +
      "{not json\n" +
      JSON.stringify(row(signOff("t1", "torn"))).slice(0, 10);
    const warnings: string[] = [];
    const rows = readAnnotations(file(text), (message) => warnings.push(message));
    expect(rows.map((r) => r.id)).toEqual([good.id]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(":2:");
  });

  it("rejects a row that fails the schema", () => {
    const bad = { ...row(signOff("t1", "x")), extra: true };
    const warnings: string[] = [];
    expect(readAnnotations(file(JSON.stringify(bad) + "\n"), (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("rejects a row of the retired `note` kind with a warning naming its line", () => {
    const old = {
      v: 1,
      id: "ann_old",
      traceId: "t1",
      annotator: human,
      createdAt: "2026-08-18T00:00:00Z",
      kind: "note",
      text: "slow",
    };
    const warnings: string[] = [];
    expect(readAnnotations(file(JSON.stringify(old) + "\n"), (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(":1:");
  });

  it("returns nothing when the file is absent", () => {
    expect(readAnnotations(path.join(os.tmpdir(), "nope", "annotations.jsonl"), () => {})).toEqual(
      [],
    );
  });
});
