import { describe, expect, it } from "vitest";

import { evalRecordFor } from "./evalRecord.js";
import { finishedTraceLines, statelogLine, tracesOf } from "./testFixtures.js";
import { traceInputText, traceOutputText } from "./traceText.js";

function project(lines: string[]) {
  const [trace] = tracesOf(...lines);
  const record = evalRecordFor(trace, "test.jsonl");
  return { input: traceInputText(trace, record), output: traceOutputText(trace, record) };
}

describe("traceInputText", () => {
  it("prefers the input agentStart recorded", () => {
    const { input } = project(finishedTraceLines("t1", { input: "write a poem", output: "ok" }));
    expect(input).toBe("write a poem");
  });

  it("renders a structured input as JSON", () => {
    const { input } = project(finishedTraceLines("t1", { input: { topic: "cats" } }));
    expect(input).toBe('{"topic":"cats"}');
  });

  it("is null when nothing recorded an input", () => {
    expect(project(finishedTraceLines("t1", { output: "x" })).input).toBeNull();
  });
});

describe("traceOutputText", () => {
  it("returns the recorded output", () => {
    const { output } = project(finishedTraceLines("t1", { output: { answer: 42 } }));
    expect(output).toEqual({ kind: "output", text: '{"answer":42}' });
  });

  it("falls back to the last assistant message, and says so", () => {
    const lines = [
      statelogLine("t1", "agentStart", { entryNode: "main", args: {} }),
      statelogLine("t1", "promptCompletion", { model: "m", completion: "first" }),
      statelogLine("t1", "promptCompletion", { model: "m", completion: { output: "second" } }),
      statelogLine("t1", "agentEnd", { timeTaken: 1 }),
    ];
    expect(project(lines).output).toEqual({ kind: "lastMessage", text: "second" });
  });

  it("is none when the trace has neither", () => {
    expect(project(finishedTraceLines("t1")).output).toEqual({ kind: "none" });
  });
});
