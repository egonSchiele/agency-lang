import { describe, expect, it } from "vitest";

import type { GraderSpec } from "@/eval/gradersJson/schema.js";

import {
  autoFill,
  draftFromSpec,
  questionForField,
  questionsFor,
  specObjectFor,
  type Answers,
  type GraderDraft,
} from "./graders.js";

function draft(answers: Answers): GraderDraft {
  return { answers };
}

function names(answers: Answers): string[] {
  return questionsFor(draft(answers)).map((question) => question.name);
}

/** The five kinds as `schema.test.ts` writes them. */
const FIVE_KINDS: GraderSpec[] = [
  {
    kind: "goal",
    name: "takes-a-position",
    goal: "recommends a direction",
    mustPass: true,
    passingScore: 0.5,
  },
  {
    kind: "checklist",
    name: "grounded",
    points: ["one package", "harness split"],
    context: "notes.md",
  },
  { kind: "number", name: "llm-calls", measure: "llmCalls", full: 0, zero: 30, weight: 0.1 },
  {
    kind: "count",
    name: "no-repeats",
    count: "toolCalls",
    tool: "fetchMarkdown",
    repeated: true,
    max: 0,
  },
  {
    kind: "command",
    name: "roundtrip",
    command: "python3 -m pytest",
    mustPass: true,
    timeoutSec: 30,
  },
];

describe("questionsFor", () => {
  it("asks only the kind until it is picked", () => {
    expect(names({})).toEqual(["kind"]);
  });

  it("asks a kind's questions then the tail", () => {
    expect(names({ kind: "count" })).toEqual([
      "kind",
      "count",
      "tool",
      "repeated",
      "max",
      "name",
      "mustPass",
      "weight",
    ]);
  });

  it("hides the tool rows for errors and shows messageStartsWith", () => {
    expect(names({ kind: "count", count: "errors" })).toEqual([
      "kind",
      "count",
      "messageStartsWith",
      "max",
      "name",
      "mustPass",
      "weight",
    ]);
  });

  it("adds a point row after each filled point", () => {
    const points = (answers: Answers) =>
      names({ kind: "checklist", ...answers }).filter((name) => name.startsWith("point"));
    expect(points({})).toEqual(["point.0"]);
    expect(points({ "point.0": "a", "point.1": "b" })).toEqual(["point.0", "point.1", "point.2"]);
    const labels = questionsFor(draft({ kind: "checklist", "point.0": "a" })).map(
      (question) => question.label,
    );
    expect(labels).toContain("point 2");
  });

  it("keeps a row for every point that was ever asked, so an emptied one stays on screen", () => {
    const points = (answers: Answers) =>
      names({ kind: "checklist", ...answers }).filter((name) => name.startsWith("point"));
    expect(points({ "point.0": "a", "point.1": "", "point.2": "c" })).toEqual([
      "point.0",
      "point.1",
      "point.2",
      "point.3",
    ]);
    expect(points({ "point.0": "a", "point.1": "", "point.2": "" })).toEqual([
      "point.0",
      "point.1",
      "point.2",
    ]);
    expect(points({ "point.0": "", "point.1": "" })).toEqual(["point.0", "point.1"]);
  });

  it("asks the passing score only for a must-pass goal", () => {
    expect(names({ kind: "goal" })).toEqual(["kind", "goal", "name", "mustPass", "weight"]);
    expect(names({ kind: "goal", mustPass: "yes" })).toEqual([
      "kind",
      "goal",
      "name",
      "mustPass",
      "passingScore",
      "weight",
    ]);
    expect(names({ kind: "count", mustPass: "yes" })).not.toContain("passingScore");
  });

  it("keeps the passing score row once it holds a value, even when the goal is not must-pass", () => {
    const answered = draft({ kind: "goal", goal: "g", passingScore: "0.7" });
    expect(names(answered.answers)).toContain("passingScore");
    expect(specObjectFor(answered).passingScore).toBe(0.7);
    expect(names({ kind: "goal", goal: "g", passingScore: " " })).not.toContain("passingScore");
  });

  it("asks max for at-most scoring and full and zero for between", () => {
    expect(names({ kind: "number" })).toEqual([
      "kind",
      "measure",
      "scoring",
      "max",
      "name",
      "mustPass",
      "weight",
    ]);
    expect(names({ kind: "number", scoring: "between" })).toEqual([
      "kind",
      "measure",
      "scoring",
      "full",
      "zero",
      "name",
      "mustPass",
      "weight",
    ]);
  });
});

describe("specObjectFor", () => {
  it("writes the count example from the spec", () => {
    const answers = {
      kind: "count",
      count: "toolCalls",
      tool: "fetchMarkdown",
      repeated: "yes",
      max: "0",
      name: "no-repeated-fetches",
      mustPass: "yes",
    };
    expect(specObjectFor(draft(answers))).toEqual({
      kind: "count",
      name: "no-repeated-fetches",
      count: "toolCalls",
      tool: "fetchMarkdown",
      repeated: true,
      max: 0,
      mustPass: true,
    });
  });

  it("drops a hidden answer: a tool name typed before switching to errors", () => {
    const answers = { kind: "count", count: "errors", tool: "fetchMarkdown", max: "1", name: "n" };
    expect(specObjectFor(draft(answers))).toEqual({
      kind: "count",
      name: "n",
      count: "errors",
      max: 1,
    });
  });

  it("leaves an unparseable number as text for the parser to refuse", () => {
    const answers = { kind: "count", count: "errors", max: "ten", name: "n" };
    expect(specObjectFor(draft(answers)).max).toBe("ten");
  });

  it("never writes a none output, so scoring stays out of the file", () => {
    const answers = { kind: "number", measure: "costUsd", scoring: "atMost", max: "2", name: "n" };
    expect(specObjectFor(draft(answers))).toEqual({
      kind: "number",
      name: "n",
      measure: "costUsd",
      max: 2,
    });
  });

  it("collects the points in order and skips empty ones", () => {
    const answers = { kind: "checklist", "point.0": "a", "point.1": "", "point.2": "c", name: "n" };
    expect(specObjectFor(draft(answers))).toEqual({
      kind: "checklist",
      name: "n",
      points: ["a", "c"],
    });
  });

  it("round-trips every kind through draftFromSpec, with false read back as absent", () => {
    for (const spec of FIVE_KINDS) {
      expect(specObjectFor(draftFromSpec(spec))).toEqual(spec);
    }
    const noRepeat: GraderSpec = {
      kind: "count",
      name: "n",
      count: "toolCalls",
      repeated: false,
      max: 0,
    };
    expect(specObjectFor(draftFromSpec(noRepeat))).toEqual({
      kind: "count",
      name: "n",
      count: "toolCalls",
      max: 0,
    });
  });
});

describe("autoFill", () => {
  it("fills 0.5 for a must-pass goal with no passing score, and leaves a typed one", () => {
    expect(autoFill({ kind: "goal", mustPass: "yes" }).passingScore).toBe("0.5");
    expect(autoFill({ kind: "goal", mustPass: "yes", passingScore: "0.8" }).passingScore).toBe(
      "0.8",
    );
    expect(autoFill({ kind: "count", mustPass: "yes" }).passingScore).toBeUndefined();
  });

  it("fills 0 for a count grader's limit, which the parser requires, and leaves a typed one", () => {
    expect(autoFill({ kind: "count" }).max).toBe("0");
    expect(autoFill({ kind: "count", max: "3" }).max).toBe("3");
    expect(autoFill({ kind: "number" }).max).toBeUndefined();
  });
});

describe("number answers", () => {
  it("treats a row of spaces as empty, so it is not written as 0", () => {
    const spec = specObjectFor(draft({ kind: "count", count: "errors", max: "1", weight: "  " }));
    expect(spec).not.toHaveProperty("weight");
    expect(specObjectFor(draft({ kind: "count", max: " 2 " })).max).toBe(2);
  });
});

describe("questionForField", () => {
  it("finds a shown question by name, a list key by its first row, and nothing for a hidden one", () => {
    const checklist = draft({ kind: "checklist", "point.0": "a" });
    expect(questionForField(checklist, "points")?.name).toBe("point.0");
    expect(questionForField(checklist, "name")?.name).toBe("name");
    expect(questionForField(draft({ kind: "count", count: "errors" }), "tool")).toBeNull();
    expect(questionForField(draft({}), "name")).toBeNull();
  });
});
