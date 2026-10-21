import { describe, expect, it } from "vitest";

import { parseGradersJson } from "./schema.js";

const FILE = "t/graders.json";

const parse = (graders: unknown[]) => parseGradersJson(JSON.stringify(graders), FILE);

const fiveKinds = [
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

describe("parseGradersJson", () => {
  it("parses the five kinds", () => {
    expect(parse(fiveKinds)).toEqual(fiveKinds);
  });

  it("refuses a file that is not a list", () => {
    expect(() => parseGradersJson("{}", FILE)).toThrow(
      "t/graders.json: must be a JSON list of graders",
    );
    expect(() => parseGradersJson("not json", FILE)).toThrow(
      "t/graders.json: must be a JSON list of graders",
    );
  });

  it("names the index and the kind for an unknown kind", () => {
    expect(() => parse([{ kind: "rubric", name: "r" }])).toThrow(
      't/graders.json: grader 0: unknown kind "rubric"',
    );
    expect(() => parse(["nope"])).toThrow(
      "t/graders.json: grader 0: must be an object with a kind",
    );
  });

  it("names the index and the field for a field problem", () => {
    expect(() => parse([{ kind: "goal", name: "g" }])).toThrow(
      /t\/graders\.json: grader 0: .*goal/,
    );
    expect(() => parse([{ kind: "goal", name: "g", goal: "x", extra: 1 }])).toThrow(
      /t\/graders\.json: grader 0: .*extra/,
    );
  });

  it("refuses two graders with one name", () => {
    expect(() =>
      parse([
        { kind: "command", name: "a", command: "true" },
        { kind: "command", name: "a", command: "false" },
      ]),
    ).toThrow('t/graders.json: two graders named "a"');
  });

  it("requires passingScore on a must-pass goal grader", () => {
    expect(() => parse([{ kind: "goal", name: "g", goal: "x", mustPass: true }])).toThrow(
      "t/graders.json: grader 0 (g): a must-pass goal grader needs passingScore",
    );
    expect(() => parse([{ kind: "goal", name: "g", goal: "x" }])).not.toThrow();
  });

  it("requires exactly one way to score a number grader", () => {
    expect(() =>
      parse([{ kind: "number", name: "n", measure: "llmCalls", full: 0, zero: 1, max: 2 }]),
    ).toThrow(
      "t/graders.json: grader 0 (n): a number grader has either full and zero or max, not both",
    );
    expect(() => parse([{ kind: "number", name: "n", measure: "llmCalls" }])).toThrow(
      "t/graders.json: grader 0 (n): a number grader needs full and zero or max",
    );
    expect(() => parse([{ kind: "number", name: "n", measure: "llmCalls", full: 0 }])).toThrow(
      "t/graders.json: grader 0 (n): a number grader needs full and zero or max",
    );
  });

  it("refuses max beside either endpoint of a range", () => {
    expect(() =>
      parse([{ kind: "number", name: "n", measure: "llmCalls", full: 0, max: 30 }]),
    ).toThrow(
      "t/graders.json: grader 0 (n): a number grader has either full and zero or max, not both",
    );
  });

  it("requires max on a must-pass number grader", () => {
    expect(() =>
      parse([
        { kind: "number", name: "n", measure: "llmCalls", full: 0, zero: 30, mustPass: true },
      ]),
    ).toThrow("t/graders.json: grader 0 (n): a must-pass number grader needs max");
    expect(() =>
      parse([{ kind: "number", name: "n", measure: "llmCalls", max: 30, mustPass: true }]),
    ).not.toThrow();
  });

  it("refuses a number grader whose full and zero are the same value", () => {
    expect(() =>
      parse([{ kind: "number", name: "n", measure: "llmCalls", full: 5, zero: 5 }]),
    ).toThrow("t/graders.json: grader 0 (n): a number grader needs full and zero to differ");
  });

  it("refuses a checklist context that is not a plain relative path", () => {
    expect(() =>
      parse([{ kind: "checklist", name: "c", points: ["a"], context: "../x.md" }]),
    ).toThrow(
      "t/graders.json: grader 0 (c): context must be a path inside graderFiles/, not ../x.md",
    );
    expect(() =>
      parse([{ kind: "checklist", name: "c", points: ["a"], context: "/etc/x" }]),
    ).toThrow(
      "t/graders.json: grader 0 (c): context must be a path inside graderFiles/, not /etc/x",
    );
    expect(() =>
      parse([{ kind: "checklist", name: "c", points: ["a"], context: "sub/x.md" }]),
    ).not.toThrow();
  });

  it("refuses a count narrowing field that does not fit the count", () => {
    expect(() =>
      parse([{ kind: "count", name: "c", count: "errors", tool: "fetch", max: 0 }]),
    ).toThrow('t/graders.json: grader 0 (c): tool only applies to count "toolCalls"');
    expect(() =>
      parse([{ kind: "count", name: "c", count: "toolCalls", messageStartsWith: "x", max: 0 }]),
    ).toThrow('t/graders.json: grader 0 (c): messageStartsWith only applies to count "errors"');
    expect(() =>
      parse([{ kind: "count", name: "c", count: "llmCalls", repeated: true, max: 0 }]),
    ).toThrow('t/graders.json: grader 0 (c): repeated only applies to count "toolCalls"');
  });

  it("requires at least one non-empty point on a checklist", () => {
    expect(() => parse([{ kind: "checklist", name: "c", points: [] }])).toThrow(
      /t\/graders\.json: grader 0: .*points/,
    );
    expect(() => parse([{ kind: "checklist", name: "c", points: ["ok", ""] }])).toThrow(
      /t\/graders\.json: grader 0: .*points/,
    );
  });
});
