import { describe, expect, it } from "vitest";
import { buildForest } from "./tree.js";
import { outlineRows, type StoryRow } from "./story.js";
import { agentLoopTrace, event } from "./storyFixture.js";
import { payloadFor, valuePayload } from "./payload.js";
const options = { raw: false };
function roundRow(output: string): StoryRow {
  return outlineRows(
    buildForest([
      event("promptCompletion", 1000, "L", null, {
        completion: { output },
        usage: { inputTokens: 1000, cachedInputTokens: 17000, outputTokens: 219 },
      }),
    ])[0],
    { machinery: false, admin: false },
  )[0];
}
describe("payloads", () => {
  it("summarizes nested calls without dumping repeated input histories", () => {
    const trace = buildForest([
      event("toolCallStart", 0, "research", null, { toolName: "researchAgent" }),
      event("promptCompletion", 1000, "calls", "research", {
        threadLabel: "main",
        threadIdentity: "main-thread",
        model: "test-model",
        timeTaken: 1000,
        cost: { totalCost: 0.1 },
        messages: [{ role: "system", content: "long repeated history" }],
        completion: { output: "earlier answer" },
      }),
      event("toolCallStart", 1100, "review", "calls", { toolName: "reviewAgent" }),
      event("promptCompletion", 2000, "review-calls", "review", {
        timeTaken: 900,
        cost: { totalCost: 10 },
        completion: { output: "nested review" },
      }),
      event("promptCompletion", 4000, "calls", "research", {
        threadLabel: "main",
        threadIdentity: "main-thread",
        model: "test-model",
        timeTaken: 2000,
        cost: { totalCost: 0.2 },
        completion: { output: "latest answer" },
      }),
    ])[0];
    const row = outlineRows(trace, { machinery: false, admin: false }).find(
      (row) => row.id === "calls",
    )!;
    const text = payloadFor(row, options)
      .map((line) => ("text" in line ? line.text : ""))
      .join("\n");
    expect(text).toContain("THREAD · main");
    expect(text).toContain("Tool: researchAgent");
    expect(text).toContain("Thread: main");
    expect(text).toContain("Model: test-model");
    expect(text).toContain("2 completed LLM calls");
    expect(text).toContain("LLM time: 3.0s");
    expect(text).toContain("Cost: $0.300");
    expect(text).toContain("Latest response");
    expect(text).toContain("latest answer");
    expect(text).not.toContain("earlier answer");
    expect(text).not.toContain("nested review");
    expect(text).not.toContain("long repeated history");
    expect(
      payloadFor(row, { raw: true }).some(
        (line) => "text" in line && line.text.includes("long repeated history"),
      ),
    ).toBe(true);
  });
  it("explains rejection, partial failure and unfinished work separately", () => {
    const row = outlineRows(agentLoopTrace(), { machinery: false, admin: false }).find(
      (row) => row.id === "grep",
    )!;
    expect(payloadFor(row, options)).toContainEqual({
      kind: "meta",
      text: "interrupt rejected; completion not recorded",
    });
    if (row.kind !== "tool") {
      throw new Error("tool expected");
    }
    expect(payloadFor({ ...row, status: "failed", work: "started" }, options)).toContainEqual({
      kind: "meta",
      text: "tool failed; work occurred before it stopped",
    });
    expect(payloadFor({ ...row, status: "unfinished" }, options)).toContainEqual({
      kind: "meta",
      text: "completion not recorded",
    });
  });
  it("decodes fields and keeps whole code blocks with real newlines", () => {
    const lines = payloadFor(
      roundRow(JSON.stringify({ response: { code: "def f(): number {\n  return 1\n}" } })),
      options,
    );
    expect(lines).toContainEqual({ kind: "text", text: "response", indent: 0, role: "key" });
    expect(lines).toContainEqual({
      kind: "code",
      text: "def f(): number {\n  return 1\n}",
      language: "agency",
      indent: 4,
    });
  });
  it("shows all token bands and the raw event when requested", () => {
    const row = roundRow("hello");
    const text = payloadFor(row, options)
      .filter((line) => line.kind === "meta")
      .map((line) => line.text)
      .join(" ");
    expect(text).toContain("context 18k (17k cached)");
    expect(text).toContain("out 219");
    expect(
      payloadFor(row, { raw: true }).some(
        (line) => line.kind === "json" && line.text.includes('"completion"'),
      ),
    ).toBe(true);
  });
  it("shows owned errors, arguments, outputs and every round request", () => {
    const trace = buildForest([
      event("toolCallStart", 0, "tool", null, { toolName: "write", args: { path: "a" } }),
      event("error", 1, "tool", null, { message: "disk full", destructiveRan: true }),
    ])[0];
    const lines = payloadFor(outlineRows(trace, { machinery: false, admin: false })[0], options);
    expect(lines.some((line) => line.kind === "text" && line.text === "disk full")).toBe(true);
    expect(lines.some((line) => "text" in line && line.text === "a")).toBe(true);
    const round = roundRow("hello");
    round.node.event!.data.completion.toolCalls = [
      { id: "one", name: "read", arguments: { path: "a" } },
    ];
    expect(
      payloadFor(round, options).some(
        (line) => line.kind === "heading" && line.text.includes("read"),
      ),
    ).toBe(true);
  });
  it("raw spans expose their direct events without substituting a nested call", () => {
    const row = outlineRows(agentLoopTrace(), { machinery: true, admin: true }).find(
      (row) => row.node.id === "L",
    )!;
    const text = payloadFor(row, { raw: true })
      .map((line) => ("text" in line ? line.text : ""))
      .join("\n");
    expect(text).toContain('"promptCompletion"');
    expect(text).not.toContain('"toolCallStart"');
  });
});

it("reports estimated result tokens and recorded error origin", () => {
  const trace = buildForest([
    event("toolCallStart", 0, "tool", null, { toolName: "write" }),
    event("toolCall", 1, "tool", null, {
      toolName: "write",
      output: { __type: "resultType", success: true, value: "one\ntwo\nthree" },
    }),
    event("error", 2, "tool", null, {
      message: "disk full",
      functionName: "write",
      sourceLocation: { moduleId: "disk.agency", line: 12 },
    }),
  ])[0];
  const rows = outlineRows(trace, { machinery: false, admin: false });
  expect(
    payloadFor(
      rows.find((row) => row.kind === "tool")!,
      options,
    ),
  ).toContainEqual({ kind: "meta", text: "result: ~4 tokens" });
  const error = payloadFor(
    rows.find((row) => row.kind === "error")!,
    options,
  );
  expect(error).toContainEqual({ kind: "meta", text: "function: write" });
  expect(error).toContainEqual({ kind: "meta", text: "span: tool" });
  expect(error).toContainEqual({ kind: "meta", text: "source: disk.agency:12" });
});

it("keeps ordinary prose as wrapping text with its structured indentation", () => {
  const sentence = "The capital of France is Paris. Let me know if you want more detail.";
  expect(valuePayload({ answer: sentence })).toContainEqual({
    kind: "text",
    text: sentence,
    indent: 2,
    role: "text",
  });
  expect(valuePayload("done")).toEqual([{ kind: "text", text: "done", indent: 0, role: "text" }]);
});

it("shows unknown usage and cache writes in round details", () => {
  const row = roundRow("done");
  row.node.event!.data.usage = undefined;
  expect(payloadFor(row, options)).toContainEqual({
    kind: "meta",
    text: "context ? · fresh ? · out ?",
  });
  row.node.event!.data.usage = {
    inputTokens: 95,
    cachedInputTokens: 13824,
    cacheCreationInputTokens: 40,
    outputTokens: 190,
  };
  // Rounds are rebuilt from the recorded event, as they are during follow.
  const refreshed = outlineRows(buildForest([row.node.event!])[0], {
    machinery: false,
    admin: false,
  })[0];
  const lines = payloadFor(refreshed, options);
  expect(lines.some((line) => line.kind === "meta" && line.text.includes("40 write"))).toBe(true);
});

it.each([
  ["", "result: ~0 tokens"],
  ["12345", "result: ~2 tokens"],
  [{ __type: "resultType", success: true, value: "a".repeat(8000) }, "result: ~2.0k tokens"],
  [{ answer: "done" }, "result: ~5 tokens"],
])("estimates tool output tokens from text or compact JSON: %j", (output, expected) => {
  const trace = buildForest([event("toolCall", 1, "tool", null, { toolName: "read", output })])[0];
  const row = outlineRows(trace, { machinery: false, admin: false })[0];
  expect(payloadFor(row, options)).toContainEqual({ kind: "meta", text: expected });
});
