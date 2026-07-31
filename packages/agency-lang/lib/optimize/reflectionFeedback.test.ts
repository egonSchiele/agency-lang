import { describe, expect, it } from "vitest";

import { renderInputFeedback, renderReflectionFeedback } from "./reflectionFeedback.js";
import type { InputGrades } from "@/eval/grading/scorecard.js";
import type { EvalRecord } from "@/eval/types.js";
import { EMPTY_RECORD } from "@/eval/grading/testUtils.js";

/** A partial eval record. The record now rides on the LoadedRun rather than being
 *  read from disk, so these tests no longer need a temp file. */
function partialRecord(fields: Partial<EvalRecord>): EvalRecord {
  return { ...EMPTY_RECORD, ...fields };
}

const fakeGrader = (name: string) =>
  ({ name: () => name, weight: () => 1 } as unknown as InputGrades["grades"][number]["grader"]);

function entry(record: EvalRecord): InputGrades {
  return {
    input: { id: "q1", task: { question: "capital of France?" } },
    run: { output: "Paris", recordPath: "", workdir: "", record },
    gatesPassed: true,
    grades: [{ grader: fakeGrader("goal"), grade: { score: { kind: "scalar", value: 0.4 }, feedback: "too terse" } }],
  };
}

describe("renderInputFeedback", () => {
  it("renders input, output, errors, tool calls, and grader feedback", () => {
    const record = partialRecord({
      errors: [{ tMs: 1, errorType: "validationError", message: "missing field x", spanId: null }],
      events: [
        { kind: "tool_start", tool: "search", argsPreview: "{q:France}", model: null, tMs: 1, threadId: null, spanId: null, parentSpanId: null },
        { kind: "tool_end", tool: "search", outputPreview: "Paris is the capital", durationMs: 5, tMs: 2, threadId: null, spanId: null, parentSpanId: null },
      ],
    });
    const text = renderInputFeedback(entry(record));
    expect(text).toContain("q1");
    expect(text).toContain("Paris");
    expect(text).toContain("missing field x");
    expect(text).toContain("search");
    expect(text).toContain("too terse");
  });

  it("renders the expected output when the input carries one", () => {
    const e = entry(EMPTY_RECORD);
    e.input.expected = "New Delhi";
    expect(renderInputFeedback(e)).toContain("Expected: New Delhi");
  });

  it("degrades to grades-only feedback for an ungraded input with no run (never throws)", () => {
    const ungraded: InputGrades = { ...entry(EMPTY_RECORD), run: null, ungradedReason: "no output" };
    const text = renderInputFeedback(ungraded);
    expect(text).toContain("too terse");
    expect(text).not.toContain("Tool calls:");
  });

  it("clamps output to the char budget", () => {
    const record = partialRecord({ errors: [], events: [] });
    const e = entry(record);
    e.run!.output = "x".repeat(5000);
    expect(renderInputFeedback(e, { maxChars: 500 }).length).toBeLessThanOrEqual(540);
  });

  it("renderReflectionFeedback concatenates focus entries as given", () => {
    const record = partialRecord({ errors: [], events: [] });
    const text = renderReflectionFeedback([entry(record), entry(record)]);
    expect(text.match(/### Input/g)).toHaveLength(2);
  });
});
