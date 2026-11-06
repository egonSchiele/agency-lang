import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseStatelogJsonl } from "./parse.js";
import { event } from "./storyFixture.js";
import { traceEvents, errorEvent } from "./traceFixture.js";
import type { EventEnvelope } from "./types.js";
import { buildForest } from "./tree.js";
import { traceSummaries } from "./traceSummaries.js";
// traceSummaries.test.ts
it("summarizes each trace from its rounds and its forest totals", () => {
  const roots = buildForest(traceEvents("A", { answer: "hi", toolOutput: "out" }));
  const [summary] = traceSummaries(roots, { A: "notes · score 0.70" });
  expect(summary).toMatchObject({
    traceId: "A",
    rounds: 1,
    ask: "ask for A",
    annotation: "notes · score 0.70",
    hasError: false,
  });
});

it("knows when a trace holds an error", () => {
  const events = [...traceEvents("A", { answer: "hi", toolOutput: "out" }), errorEvent("A")];
  expect(traceSummaries(buildForest(events), {})[0].hasError).toBe(true);
});

it("does not read inherited annotations", () => {
  const root = buildForest(traceEvents("__proto__", { answer: "hi", toolOutput: "out" }));
  expect(traceSummaries(root, {})[0].annotation).toBeUndefined();
});

it("carries the trace root's agent name", () => {
  const roots = buildForest(
    traceEvents("A", { answer: "hi", toolOutput: "out", agentName: "agency-agent/coordinator" }),
  );
  expect(traceSummaries(roots, {})[0].agentName).toBe("agency-agent/coordinator");
});

describe("tool counts", () => {
  /** One tool call in its own span, holding the events after its start. */
  function tool(
    span: string,
    at: number,
    parent: string | null,
    ...rest: [string, Record<string, unknown>][]
  ) {
    return [
      event("toolCallStart", at, span, parent, { toolName: span }),
      ...rest.map(([type, data], position) => event(type, at + position + 1, span, parent, data)),
    ];
  }
  const countsOf = (events: EventEnvelope[]) => {
    const summary = traceSummaries(buildForest(events), {})[0];
    return {
      toolCalls: summary.toolCalls,
      toolsFailed: summary.toolsFailed,
      toolsRejected: summary.toolsRejected,
      toolsUnfinished: summary.toolsUnfinished,
      otherErrors: summary.otherErrors,
    };
  };

  it("counts each way a tool call can end", () => {
    const events = [
      ...tool("completed", 0, null, ["toolCall", { toolName: "completed", output: "ok" }]),
      ...tool("failed", 10, null, ["error", { message: "boom" }]),
      ...tool("rejected", 20, null, [
        "interruptResolved",
        { interruptId: "r", outcome: "rejected" },
      ]),
      ...tool("awaiting", 30, null, ["interruptThrown", { interruptId: "a" }]),
      ...tool("unfinished", 40, null),
    ];
    expect(countsOf(events)).toEqual({
      toolCalls: 5,
      toolsFailed: 1,
      toolsRejected: 1,
      toolsUnfinished: 1,
      otherErrors: 0,
    });
  });

  it("counts a tool call inside a subagent", () => {
    const events = [
      event("subprocessStarted", 0, "sub", null),
      ...tool("inner", 1, "sub", ["error", { message: "boom" }]),
      event("subprocessEnd", 5, "sub", null),
    ];
    expect(countsOf(events)).toMatchObject({ toolCalls: 1, toolsFailed: 1 });
  });

  it("gives zeros for a trace with no tool calls", () => {
    expect(countsOf([event("promptCompletion", 0, "L", null, { completion: {} })])).toEqual({
      toolCalls: 0,
      toolsFailed: 0,
      toolsRejected: 0,
      toolsUnfinished: 0,
      otherErrors: 0,
    });
  });

  it("counts an error inside a tool that went on to complete", () => {
    const events = tool(
      "recovered",
      0,
      null,
      ["error", { message: "retrying" }],
      ["toolCall", { toolName: "recovered", output: "ok" }],
    );
    expect(countsOf(events)).toMatchObject({ toolCalls: 1, toolsFailed: 0, otherErrors: 1 });
  });

  it("leaves a failed tool's error out of otherErrors and counts one outside any tool", () => {
    const failedOnly = tool("failed", 0, null, ["error", { message: "boom" }]);
    expect(countsOf(failedOnly).otherErrors).toBe(0);
    const crashed = [...failedOnly, event("error", 10, null, null, { message: "crash" })];
    expect(countsOf(crashed).otherErrors).toBe(1);
  });

  it("counts an error in a nested tool once", () => {
    const events = [
      ...tool("outer", 0, null),
      ...tool("inner", 1, "outer", ["error", { message: "boom" }]),
    ];
    expect(countsOf(events)).toMatchObject({
      toolCalls: 2,
      toolsFailed: 1,
      toolsUnfinished: 1,
      otherErrors: 0,
    });
  });
});

it("counts a recorded rejected tool call as rejected", () => {
  // Recorded with a scripted model that calls `removeNote`, under a handler
  // that rejects its interrupt. A rejection logs neither an error nor a
  // `toolCall` event, so the status comes from the interrupt in the span.
  const text = readFileSync(new URL("./fixtures/rejected-tool.jsonl", import.meta.url), "utf8");
  const [summary] = traceSummaries(buildForest(parseStatelogJsonl(text).events), {});
  expect(summary).toMatchObject({
    toolCalls: 1,
    toolsRejected: 1,
    toolsUnfinished: 0,
    toolsFailed: 0,
    hasError: false,
  });
});
