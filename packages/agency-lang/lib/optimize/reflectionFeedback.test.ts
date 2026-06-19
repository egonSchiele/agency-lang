import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { renderInputFeedback, renderReflectionFeedback } from "./reflectionFeedback.js";
import type { InputGrades } from "./grading/scorecard.js";

function writeRecord(record: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gepa-fb-"));
  const file = path.join(dir, "eval-record.json");
  fs.writeFileSync(file, JSON.stringify(record));
  return file;
}

const fakeGrader = (name: string) =>
  ({ name: () => name, weight: () => 1 } as unknown as InputGrades["grades"][number]["grader"]);

function entry(recordPath: string): InputGrades {
  return {
    input: { id: "q1", args: { question: "capital of France?" } },
    run: { output: "Paris", recordPath },
    gatesPassed: true,
    grades: [{ grader: fakeGrader("goal"), grade: { score: { kind: "scalar", value: 0.4 }, feedback: "too terse" } }],
  };
}

describe("renderInputFeedback", () => {
  it("renders input, output, errors, tool calls, and grader feedback", () => {
    const recordPath = writeRecord({
      errors: [{ tMs: 1, errorType: "validationError", message: "missing field x", spanId: null }],
      events: [
        { kind: "tool_start", tool: "search", argsPreview: "{q:France}", model: null, tMs: 1, threadId: null, spanId: null, parentSpanId: null },
        { kind: "tool_end", tool: "search", outputPreview: "Paris is the capital", durationMs: 5, tMs: 2, threadId: null, spanId: null, parentSpanId: null },
      ],
    });
    const text = renderInputFeedback(entry(recordPath));
    expect(text).toContain("q1");
    expect(text).toContain("Paris");
    expect(text).toContain("missing field x");
    expect(text).toContain("search");
    expect(text).toContain("too terse");
  });

  it("renders the expected output when the input carries one", () => {
    const e = entry("/no/such/record.json");
    e.input.expected = "New Delhi";
    expect(renderInputFeedback(e)).toContain("Expected: New Delhi");
  });

  it("degrades to grades-only feedback when the trace is missing (never throws)", () => {
    const text = renderInputFeedback(entry("/no/such/record.json"));
    expect(text).toContain("too terse");
    expect(text).not.toContain("Tool calls:");
  });

  it("clamps output to the char budget", () => {
    const recordPath = writeRecord({ errors: [], events: [] });
    const e = entry(recordPath);
    e.run.output = "x".repeat(5000);
    expect(renderInputFeedback(e, { maxChars: 500 }).length).toBeLessThanOrEqual(540);
  });

  it("renderReflectionFeedback concatenates focus entries as given", () => {
    const recordPath = writeRecord({ errors: [], events: [] });
    const text = renderReflectionFeedback([entry(recordPath), entry(recordPath)]);
    expect(text.match(/### Input/g)).toHaveLength(2);
  });
});
