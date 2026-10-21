import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { AgencyRunner } from "../agencyRunner.js";
import { loadedRun } from "../testUtils.js";
import type { GraderInput } from "../types.js";
import { ChecklistJudge } from "./checklistJudge.js";

const POINTS = ["one package", "harness split", "what drives releases"];

type Answer = { name: string; pass: boolean | null; evidence: string };

function verdictOf(answers: Answer[], note = "note") {
  return { points: answers, note };
}

function judgeInput(
  verdict: ReturnType<typeof verdictOf>,
  graderFiles?: string,
  onCall?: (argsString: string) => void,
): GraderInput {
  return {
    test: { id: "i1", input: "t" },
    run: loadedRun("the work"),
    runAgency: new AgencyRunner({}, async (a) => {
      onCall?.(a.argsString);
      return { data: verdict };
    }),
    graderFiles,
  };
}

const twoOfThree = verdictOf(
  [
    { name: "package", pass: true, evidence: "one bin" },
    { name: "split", pass: true, evidence: "AgentBrain" },
    { name: "releases", pass: false, evidence: "" },
  ],
  "Two of three.",
);

describe("ChecklistJudge", () => {
  it("scores the share of points that passed and carries the points", async () => {
    const judge = new ChecklistJudge({ name: "grounded", points: POINTS });
    const grade = await judge.run(judgeInput(twoOfThree));
    expect(grade.score.kind).toBe("scalar");
    if (grade.score.kind === "scalar") expect(grade.score.value).toBeCloseTo(0.667, 3);
    expect(grade.feedback).toBe("Two of three.");
    expect(grade.points).toEqual([
      { point: "one package", pass: true, evidence: "one bin" },
      { point: "harness split", pass: true, evidence: "AgentBrain" },
      { point: "what drives releases", pass: false, evidence: "" },
    ]);
  });

  it("counts cannot-tell as a fail", async () => {
    const judge = new ChecklistJudge({ name: "c", points: ["a"] });
    const grade = await judge.run(judgeInput(verdictOf([{ name: "a", pass: null, evidence: "" }])));
    expect(grade.score).toEqual({ kind: "scalar", value: 0 });
    expect(grade.points?.[0].pass).toBe(false);
  });

  it("fails the grader when the judge answers the wrong number of points", async () => {
    const judge = new ChecklistJudge({ name: "c", points: POINTS });
    const two = verdictOf(twoOfThree.points.slice(0, 2));
    await expect(judge.run(judgeInput(two))).rejects.toThrow(
      "c: the judge answered 2 points for 3 asked",
    );
  });

  it("sends the points, the work, and the context from the run's graderFiles copy", async () => {
    const graderFiles = fs.mkdtempSync(path.join(os.tmpdir(), "checklist-judge-"));
    fs.writeFileSync(path.join(graderFiles, "notes.md"), "the notes");
    let seen = "";
    const judge = new ChecklistJudge({ name: "c", points: ["a"], context: "notes.md" });
    await judge.run(
      judgeInput(verdictOf([{ name: "a", pass: true, evidence: "" }]), graderFiles, (args) => {
        seen = args;
      }),
    );
    expect(seen).toBe('["a"], "the work", "the notes"');
  });

  it("sends an empty context when the grader names none", async () => {
    let seen = "";
    const judge = new ChecklistJudge({ name: "c", points: ["a"] });
    await judge.run(
      judgeInput(verdictOf([{ name: "a", pass: true, evidence: "" }]), undefined, (args) => {
        seen = args;
      }),
    );
    expect(seen).toBe('["a"], "the work", ""');
  });

  it("fails with a message when the context file is missing", async () => {
    const judge = new ChecklistJudge({ name: "c", points: ["a"], context: "notes.md" });
    await expect(judge.run(judgeInput(verdictOf([])))).rejects.toThrow(
      "c: context file notes.md is not in graderFiles/",
    );
    const graderFiles = fs.mkdtempSync(path.join(os.tmpdir(), "checklist-judge-"));
    await expect(judge.run(judgeInput(verdictOf([]), graderFiles))).rejects.toThrow(
      "c: context file notes.md is not in graderFiles/",
    );
  });

  it("refuses a context that escapes graderFiles/", async () => {
    const graderFiles = fs.mkdtempSync(path.join(os.tmpdir(), "checklist-judge-"));
    fs.writeFileSync(path.join(graderFiles, "..", "outside.md"), "secret");
    const judge = new ChecklistJudge({ name: "c", points: ["a"], context: "../outside.md" });
    await expect(judge.run(judgeInput(verdictOf([]), graderFiles))).rejects.toThrow(
      "c: context file ../outside.md is not in graderFiles/",
    );
  });

  it("refuses a context that is a symlink, or sits under one", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "checklist-outside-"));
    fs.writeFileSync(path.join(outside, "secret.md"), "secret");
    const graderFiles = fs.mkdtempSync(path.join(os.tmpdir(), "checklist-judge-"));
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(graderFiles, "notes.md"));
    fs.symlinkSync(outside, path.join(graderFiles, "sub"));
    for (const context of ["notes.md", "sub/secret.md"]) {
      const judge = new ChecklistJudge({ name: "c", points: ["a"], context });
      await expect(judge.run(judgeInput(verdictOf([]), graderFiles))).rejects.toThrow(
        `c: context file ${context} is not in graderFiles/`,
      );
    }
  });

  it("refuses samples greater than 1", () => {
    expect(() => new ChecklistJudge({ name: "c", points: ["a"], samples: 2 })).toThrow(
      "c: a checklist judge cannot be sampled; its per-point answers do not survive aggregation",
    );
  });

  it("a must-pass checklist passes only when every point passed", () => {
    const judge = new ChecklistJudge({ name: "c", points: POINTS, mustPass: true });
    const oneFailed = {
      score: { kind: "scalar" as const, value: 0.667 },
      points: [
        { point: "a", pass: true, evidence: "" },
        { point: "b", pass: false, evidence: "" },
      ],
    };
    expect(judge.passes(oneFailed)).toBe(false);
    const allPassed = {
      score: { kind: "scalar" as const, value: 1 },
      points: [{ point: "a", pass: true, evidence: "" }],
    };
    expect(judge.passes(allPassed)).toBe(true);
    expect(judge.passes({ score: { kind: "scalar", value: 1 } })).toBe(true);
    expect(judge.passes({ score: { kind: "scalar", value: 0.9 } })).toBe(false);
  });

  it("is the bundled judge by version unless loaded from a file", () => {
    const judge = new ChecklistJudge({ name: "c", points: ["a"] });
    expect(judge.annotator()).toEqual({ kind: "judge", id: "checklist-judge@1" });
    judge.revision = "/t/graders.json@abc";
    expect(judge.annotator()).toEqual({ kind: "grader", id: "/t/graders.json@abc" });
  });
});
