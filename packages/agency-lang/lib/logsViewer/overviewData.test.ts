import { describe, expect, it } from "vitest";

import { overviewData, threadNames } from "./overviewData.js";
import { parseStatelogJsonl } from "./parse.js";
import { buildForest } from "./tree.js";
import { leaf, span, trace } from "./timeline/fixture.js";

function fixture() {
  const rounds = [
    leaf("promptCompletion", 1_000, {
      model: '"m1"',
      timeTaken: 100,
      usage: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 5 },
      cost: { totalCost: 0.01 },
    }),
    leaf("promptCompletion", 2_000, {
      model: '"m1"',
      timeTaken: 800,
      usage: { inputTokens: 30, cachedInputTokens: 200, outputTokens: 6 },
      cost: { totalCost: 0.02 },
    }),
    leaf("promptCompletion", 3_000, {
      model: '"m1"',
      timeTaken: 200,
      usage: { inputTokens: 40, cachedInputTokens: 2_000, outputTokens: 7 },
      cost: { totalCost: 0.015 },
    }),
  ];
  return trace([
    span("llmCall", rounds, { id: "L" }),
    span("toolExecution", [leaf("toolCallStart", 100), leaf("toolCall", 200)], { id: "t1" }),
    span("toolExecution", [leaf("toolCallStart", 300), leaf("toolCall", 400)], { id: "t2" }),
    leaf("interruptResolved", 500, { outcome: "approved" }),
    leaf("interruptResolved", 600, { outcome: "rejected" }),
    leaf("error", 700),
  ]);
}

describe("overviewData", () => {
  it("uses individual request durations rather than the surrounding invocation", () => {
    const data = overviewData(fixture());
    expect(data.rounds.map((round) => round.durationMs)).toEqual([100, 800, 200]);
    expect(data.rounds.map((round) => round.id)).toEqual(["round:L:0", "round:L:1", "round:L:2"]);
    expect(data.costUsd).toBeCloseTo(0.045);
  });

  it("uses trace-root rounds for elapsed time", () => {
    const data = overviewData(trace([leaf("promptCompletion", 1_000, { timeTaken: 100 })]));
    expect(data.workingMs).toBe(100);
    expect(data.waitingMs).toBe(0);
  });

  it("reports a pending root prompt after an earlier completed prompt", () => {
    const jsonl = [
      event("promptStart", 0),
      event("promptCompletion", 100, { timeTaken: 100 }),
      event("promptStart", 200),
    ].join("\n");
    const roots = buildForest(parseStatelogJsonl(jsonl).events);
    expect(overviewData(roots[0]).status).toBe("running");
  });

  it("does not let another span's completion close a pending prompt", () => {
    const jsonl = [
      event("promptStart", 0, {}, "A"),
      event("promptStart", 50, {}, "B"),
      event("promptCompletion", 100, { timeTaken: 100 }, "A"),
    ].join("\n");
    const roots = buildForest(parseStatelogJsonl(jsonl).events);
    expect(overviewData(roots[0]).status).toBe("running");
  });
});

function event(
  type: string,
  at: number,
  extra: Record<string, unknown> = {},
  spanId: string | null = null,
): string {
  return JSON.stringify({
    format_version: 1,
    trace_id: "T",
    project_id: "p",
    span_id: spanId,
    parent_span_id: null,
    data: { type, timestamp: new Date(at).toISOString(), ...extra },
  });
}

it("omits missing models from mixed named and unnamed rounds", () => {
  const root = trace([
    leaf("promptCompletion", 100),
    leaf("promptCompletion", 200, { model: '"m1"' }),
  ]);
  expect(overviewData(root).models).toEqual(["m1"]);
});
it.each(["runtimeError", "validationError", "limitExceeded", "structuredOutput", "finalizeError"])(
  "keeps a tool running after an unrelated %s",
  (errorType) => {
    const root = trace([
      span("toolExecution", [leaf("toolCallStart", 100), leaf("error", 200, { errorType })], {
        id: "tool",
      }),
    ]);
    expect(overviewData(root).status).toBe("running");
  },
);
it("ends a tool on a toolError", () => {
  const root = trace([
    span(
      "toolExecution",
      [leaf("toolCallStart", 100), leaf("error", 200, { errorType: "toolError" })],
      { id: "tool" },
    ),
  ]);
  expect(overviewData(root).status).toBe("done");
});

describe("overview errors", () => {
  function run() {
    const rounds = [
      leaf("promptCompletion", 1_000, {
        timeTaken: 100,
        completion: { toolCalls: [{ name: "write", arguments: { path: "a" } }] },
      }),
      leaf("promptCompletion", 3_000, { timeTaken: 100, completion: { output: "done" } }),
    ];
    const tool = span(
      "toolExecution",
      [
        leaf("toolCallStart", 1_100, { toolName: "write", args: { path: "a" } }),
        leaf("error", 1_200, { message: "disk full", errorType: "toolError" }),
      ],
      { id: "t1" },
    );
    // The forest records a span's first timestamp; the fixture builder does not.
    tool.firstTs = 1_100;
    return trace([
      leaf("agentStart", 0, { entryNode: "main" }),
      span(
        "llmCall",
        [
          ...rounds,
          tool,
          leaf("error", 3_500, { message: "hook failed", errorType: "runtimeError" }),
        ],
        { id: "L" },
      ),
      leaf("error", 4_000, { message: "hook failed", errorType: "runtimeError" }),
      leaf("agentEnd", 4_100, {}),
    ]);
  }

  it("marks a failed tool on the call that requested it and an error between calls on the last earlier call", () => {
    const data = overviewData(run());
    expect(data.status).toBe("crashed");
    expect(data.errors.map((error) => [error.message, error.count])).toEqual([
      ["disk full", 1],
      ["hook failed", 2],
    ]);
    expect(data.calls.map((call) => call.errors.map((error) => error.message))).toEqual([
      ["disk full"],
      ["hook failed"],
    ]);
    expect(data.calls[0].tools.map((tool) => tool.name)).toEqual(["write"]);
  });

  it("marks an error with no earlier call on the first call", () => {
    const root = trace([
      leaf("error", 100, { message: "early" }),
      span("llmCall", [leaf("promptCompletion", 1_000, { timeTaken: 100 })], { id: "L" }),
    ]);
    expect(overviewData(root).calls[0].errors.map((error) => error.message)).toEqual(["early"]);
  });

  it("gives a request that failed before the provider answered its own column", () => {
    const root = trace([
      span(
        "llmCall",
        [
          leaf("promptCompletion", 1_000, { timeTaken: 100 }),
          leaf("error", 2_000, { message: "503 overloaded", errorType: "llmError" }),
        ],
        { id: "L" },
      ),
    ]);
    const data = overviewData(root);
    expect(data.calls.map((call) => [call.round?.index, call.failure?.message])).toEqual([
      [0, undefined],
      [undefined, "503 overloaded"],
    ]);
    expect(data.calls[1].id).toBe("leaf:L:error:0");
  });

  it("places a failed request inside the tool it ran in, like a completed one", () => {
    const inner = span(
      "llmCall",
      [leaf("error", 2_000, { message: "503 overloaded", errorType: "llmError" })],
      { id: "B" },
    );
    const tool = span(
      "toolExecution",
      [leaf("toolCallStart", 1_100, { toolName: "researchAgent", args: {} }), inner],
      { id: "t" },
    );
    const root = trace([
      span(
        "llmCall",
        [
          leaf("promptCompletion", 1_000, {
            timeTaken: 100,
            completion: { output: "", toolCalls: [{ name: "researchAgent", arguments: {} }] },
          }),
          tool,
        ],
        { id: "A" },
      ),
    ]);
    const failed = overviewData(root).calls.find((call) => call.failure !== undefined)!;
    expect(failed.inside).toEqual({ toolName: "researchAgent", requestedBy: 0 });
    expect(failed.enclosing.map((tool) => tool.toolName)).toEqual(["researchAgent"]);
  });

  it("keeps the memory manager's own request failures out of the chart columns", () => {
    const root = trace([
      span("llmCall", [leaf("promptCompletion", 1_000, { timeTaken: 100 })], { id: "L" }),
      span(
        "memoryCompaction",
        [leaf("error", 2_000, { message: "503 overloaded", errorType: "llmError" })],
        { id: "M" },
      ),
    ]);
    const data = overviewData(root);
    expect(data.calls.map((call) => call.round?.index)).toEqual([0]);
    expect(data.calls[0].errors.map((error) => error.message)).toEqual(["503 overloaded"]);
  });
});

describe("threadNames", () => {
  it("lists distinct names in order of first use, numbering a repeated name", () => {
    const root = trace([
      span(
        "llmCall",
        [leaf("promptCompletion", 1_000, { threadIdentity: "a", threadLabel: "main" })],
        { id: "A" },
      ),
      span("llmCall", [leaf("promptCompletion", 2_000, { threadIdentity: "b" })], { id: "B" }),
      span("llmCall", [leaf("promptCompletion", 3_000, { threadIdentity: "c" })], { id: "C" }),
      span(
        "llmCall",
        [leaf("promptCompletion", 4_000, { threadIdentity: "a", threadLabel: "main" })],
        { id: "A2" },
      ),
    ]);
    expect(threadNames(overviewData(root).calls)).toEqual(["main", "unnamed", "unnamed #2"]);
  });

  it("tells two threads one tool started apart", () => {
    const sub = (id: string, at: number) =>
      span(
        "toolExecution",
        [
          leaf("toolCallStart", at, { toolName: "subagent", args: {} }),
          span("llmCall", [leaf("promptCompletion", at + 10, { threadIdentity: id })], { id }),
        ],
        { id: `tool-${id}` },
      );
    const data = overviewData(trace([sub("x", 1_000), sub("y", 2_000)]));
    expect(data.calls.map((call) => call.threadName)).toEqual(["subagent", "subagent #2"]);
  });
});
