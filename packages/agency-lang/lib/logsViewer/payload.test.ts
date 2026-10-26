import { describe, expect, it } from "vitest";
import { buildForest } from "./tree.js";
import { outlineRows, type StoryRow } from "./story.js";
import { agentLoopTrace, event } from "./storyFixture.js";
import {
  ARGUMENT_PREVIEW_CHARS,
  commentsPayload,
  payloadFor,
  roundResponsePayload,
  RESULT_PREVIEW_CHARS,
  valuePayload,
} from "./payload.js";
import { roundsOf } from "./timeline/rounds.js";
import { overviewData } from "./overviewData.js";
import { leaf, span, trace } from "./timeline/fixture.js";
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
    expect(text).toContain("Thread · main");
    expect(text).toContain("2 LLM calls · test-model");
    expect(text).toContain("ran 4.0s · LLM time 3.0s · $0.300");
    expect(text).not.toContain("researchAgent");
    expect(text).not.toContain("Latest response");
    expect(text).not.toContain("latest answer");
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
    expect(text).toContain("input 18k (17k cached)");
    expect(text).toContain("output 219");
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
  ).toContainEqual({ kind: "heading", text: "→ RESULT · ~4 tokens", tone: "tool" });
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
  expect(valuePayload({ answer: sentence })).toEqual([
    { kind: "pair", key: "answer", text: sentence, indent: 0 },
  ]);
  expect(valuePayload({ answer: `${sentence}\nMore.` })).toContainEqual({
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
    text: "input ? · output ?",
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
  ["", "→ RESULT · ~0 tokens"],
  ["12345", "→ RESULT · ~2 tokens"],
  [{ __type: "resultType", success: true, value: "a".repeat(8000) }, "→ RESULT · ~2.0k tokens"],
  [{ answer: "done" }, "→ RESULT · ~5 tokens"],
])("estimates tool output tokens from text or compact JSON: %j", (output, expected) => {
  const trace = buildForest([event("toolCall", 1, "tool", null, { toolName: "read", output })])[0];
  const row = outlineRows(trace, { machinery: false, admin: false })[0];
  expect(payloadFor(row, options)).toContainEqual({
    kind: "heading",
    text: expected,
    tone: "tool",
  });
});

it("shows a tool row as the call with its arguments, then the result, with no section labels", () => {
  const trace = buildForest([
    event("toolCallStart", 0, "tool", null, { toolName: "read", args: { path: "a.md" } }),
    event("toolCall", 1, "tool", null, {
      toolName: "read",
      args: { path: "a.md" },
      output: "text",
    }),
  ])[0];
  const row = outlineRows(trace, { machinery: false, admin: false })[0];
  const texts = payloadFor(row, options).map((line) => {
    if (line.kind === "pair") {
      return `${line.key}: ${line.text}`;
    }
    return "text" in line ? line.text : line.kind;
  });
  expect(texts).toEqual([
    "TOOL CALL · read",
    "completed",
    "duration not recorded",
    "path: a.md",
    "→ RESULT · ~1 tokens",
    "text",
  ]);
});

it("names every group by its thread and call count, and charts a sub-agent's calls", () => {
  const call = (span: string, parent: string | null, at: number, identity: string) =>
    event("promptCompletion", at, span, parent, {
      threadIdentity: identity,
      threadLabel: "main",
      model: "m1",
      timeTaken: 100,
      cost: { totalCost: 0.1 },
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
      completion: { output: "ok" },
    });
  const trace = buildForest([
    call("outer", null, 1_000, "T"),
    event("toolCallStart", 1_100, "research", "outer", { toolName: "researchAgent" }),
    call("inner", "research", 2_000, "T"),
    call("inner", "research", 3_000, "T"),
    event("toolCallStart", 3_100, "review", "outer", { toolName: "reviewAgent" }),
    call("own", "review", 4_000, "R"),
  ])[0];
  const groups = outlineRows(trace, { machinery: false, admin: false }).filter(
    (row) => row.kind === "llmGroup",
  );
  expect(groups.map((row) => (row.kind === "llmGroup" ? row.title : ""))).toEqual([
    "Thread · main · 2 LLM calls",
    "Thread · main · 1 LLM call",
  ]);
  const detail = payloadFor(groups[0], { raw: false, trace });
  expect(detail[0]).toEqual({
    kind: "heading",
    text: "Thread · main · 2 LLM calls",
    tone: "assistant",
  });
  const charts = detail.find((line) => line.kind === "charts");
  expect(charts?.kind === "charts" && charts.calls.map((c) => c.round?.index)).toEqual([1, 2]);
  expect(charts?.kind === "charts" && charts.calls.every((c) => c.enclosing.length === 0)).toBe(
    true,
  );
  expect(payloadFor(groups[0], { raw: false }).some((line) => line.kind === "charts")).toBe(false);
});

it("restores arguments the model sent as null that the runtime dropped, and says why", () => {
  const toolSpan = (id: string, at: number, args: Record<string, unknown>) => {
    const node = span(
      "toolExecution",
      [leaf("toolCallStart", at, { toolName: "researchAgent", args })],
      { id },
    );
    node.firstTs = at;
    return node;
  };
  const root = trace([
    span(
      "llmCall",
      [
        leaf("promptCompletion", 2_000, {
          model: '"m1"',
          timeTaken: 100,
          completion: {
            toolCalls: [
              {
                name: "researchAgent",
                arguments: { agencyTopic: false, maxSeconds: null, userMsg: "first" },
              },
              { name: "researchAgent", arguments: { agencyTopic: true, userMsg: "second" } },
            ],
          },
        }),
        toolSpan("t1", 2_100, { agencyTopic: false, userMsg: "first" }),
        toolSpan("t2", 2_200, { agencyTopic: true, userMsg: "second" }),
      ],
      { id: "L" },
    ),
  ]);
  const tools = outlineRows(root, { machinery: false, admin: false }).filter(
    (row) => row.kind === "tool",
  );
  const texts = (row: StoryRow) =>
    payloadFor(row, options).map((line) =>
      line.kind === "pair" ? `${line.key}: ${line.text}` : "text" in line ? line.text : line.kind,
    );
  expect(texts(tools[0])).toEqual([
    "TOOL CALL · researchAgent",
    "completion not recorded",
    "duration not recorded",
    "agencyTopic: false",
    "userMsg: first",
    "maxSeconds: null",
    "Null arguments in tool calls are dropped, defaults apply",
  ]);
  expect(texts(tools[1])).not.toContain("Null arguments in tool calls are dropped, defaults apply");
  expect(texts(tools[1])).not.toContain("maxSeconds: null");
});

it("cuts long arguments on the LLM call row and keeps them whole on the overview", () => {
  const long = "x".repeat(ARGUMENT_PREVIEW_CHARS + 50);
  const root = trace([
    span(
      "llmCall",
      [
        leaf("promptCompletion", 2_000, {
          model: '"m1"',
          timeTaken: 100,
          completion: {
            toolCalls: [
              { name: "researchAgent", arguments: { agencyTopic: false, userMsg: long } },
            ],
          },
        }),
      ],
      { id: "L" },
    ),
  ]);
  const round = roundsOf(root)[0];
  const row = outlineRows(root, { machinery: false, admin: false }).find(
    (candidate) => candidate.kind === "round",
  )!;
  const detail = payloadFor(row, options);
  const cut = detail.find((line) => line.kind === "pair" && line.key === "userMsg")!;
  expect(cut).toMatchObject({ text: `${"x".repeat(ARGUMENT_PREVIEW_CHARS)}…` });
  expect(detail).toContainEqual({ kind: "pair", key: "agencyTopic", text: "false", indent: 0 });
  const whole = roundResponsePayload(round);
  expect(whole).toContainEqual({ kind: "pair", key: "userMsg", text: long, indent: 0 });
});

describe("roundResponsePayload with tool results", () => {
  function fixture(toolEvents: ReturnType<typeof leaf>[]) {
    const root = trace([
      span(
        "llmCall",
        [
          leaf("promptCompletion", 1_000, {
            timeTaken: 100,
            completion: { toolCalls: [{ name: "read", arguments: { path: "a" } }] },
          }),
          Object.assign(span("toolExecution", toolEvents, { id: "t" }), { firstTs: 1_100 }),
        ],
        { id: "L" },
      ),
    ]);
    const data = overviewData(root);
    return roundResponsePayload(data.rounds[0], data.calls[0].tools).map((line) => {
      if (line.kind === "pair") {
        return `${line.key}: ${line.text}`;
      }
      return "text" in line ? line.text : line.kind;
    });
  }

  it("shows a completed tool's output after its request", () => {
    const lines = fixture([
      leaf("toolCallStart", 1_100, { toolName: "read", args: { path: "a" } }),
      leaf("toolCall", 1_200, { toolName: "read", output: "file text" }),
    ]);
    expect(lines.slice(lines.indexOf("TOOL CALL · read"))).toEqual([
      "TOOL CALL · read",
      "path: a",
      "→ RESULT",
      "file text",
    ]);
  });

  it("shows a failed tool's error, a waiting tool, and an unfinished tool", () => {
    expect(
      fixture([
        leaf("toolCallStart", 1_100, { toolName: "read", args: { path: "a" } }),
        leaf("error", 1_200, { message: "no such file", errorType: "toolError" }),
      ]),
    ).toEqual(expect.arrayContaining(["✖ RESULT · tool failed", "no such file"]));
    expect(
      fixture([
        leaf("toolCallStart", 1_100, { toolName: "read", args: { path: "a" } }),
        leaf("interruptResolved", 1_150, { interruptId: "i", outcome: "passed" }),
      ]),
    ).toContain("⏸ RESULT · waiting for a response");
    expect(
      fixture([leaf("toolCallStart", 1_100, { toolName: "read", args: { path: "a" } })]),
    ).toContain("⋯ RESULT · completion not recorded");
  });

  it("shortens a long result to the preview limit", () => {
    const lines = fixture([
      leaf("toolCallStart", 1_100, { toolName: "read", args: { path: "a" } }),
      leaf("toolCall", 1_200, { toolName: "read", output: "x".repeat(RESULT_PREVIEW_CHARS + 50) }),
    ]);
    expect(lines.at(-2)).toMatch(/^x+$/);
    expect(lines.at(-1)).toBe("… ~13 more tokens · x to show");
  });
});

it("a group charts the request that failed in it, and counts the same errors the charts mark", () => {
  const call = (span: string, parent: string | null, at: number, identity: string) =>
    event("promptCompletion", at, span, parent, {
      threadIdentity: identity,
      threadLabel: "main",
      model: "m1",
      timeTaken: 100,
      cost: { totalCost: 0.1 },
      completion: { output: "ok" },
    });
  const trace = buildForest([
    call("outer", null, 1_000, "T"),
    event("toolCallStart", 1_100, "research", "outer", { toolName: "researchAgent" }),
    call("inner", "research", 2_000, "T"),
    event("error", 2_500, "inner", "research", { errorType: "llmError", message: "overloaded" }),
    event("toolCallStart", 2_600, "deeper", "inner", { toolName: "reviewAgent" }),
    call("nested", "deeper", 3_000, "R"),
    event("error", 3_100, "nested", "deeper", { errorType: "llmError", message: "nested" }),
  ])[0];
  const groups = outlineRows(trace, { machinery: false, admin: false }).filter(
    (row) => row.kind === "llmGroup",
  );
  const detail = payloadFor(groups[0], { raw: false, trace });
  // One error of its own; the nested thread's error belongs to the nested group.
  expect(detail.some((line) => line.kind === "text" && line.text === "✖ 1 error")).toBe(true);
  const charts = detail.find((line) => line.kind === "charts");
  expect(
    charts?.kind === "charts" &&
      charts.calls.map((c) => (c.round === undefined ? "✖" : c.round.index + 1)),
  ).toEqual([2, "✖"]);
});

it("shows arguments recorded as anything but an object as recorded", () => {
  const tool = span(
    "toolExecution",
    [leaf("toolCallStart", 2_100, { toolName: "echo", args: "raw text" })],
    { id: "t1" },
  );
  tool.firstTs = 2_100;
  const root = trace([
    span(
      "llmCall",
      [
        leaf("promptCompletion", 2_000, {
          model: '"m1"',
          timeTaken: 100,
          completion: { toolCalls: [{ name: "echo", arguments: { text: null } }] },
        }),
        tool,
      ],
      { id: "L" },
    ),
  ]);
  const row = outlineRows(root, { machinery: false, admin: false }).find(
    (candidate) => candidate.kind === "tool",
  )!;
  const texts = payloadFor(row, options).map((line) => ("text" in line ? line.text : line.kind));
  expect(texts).toContain("raw text");
  expect(texts.some((text) => text.startsWith("0:"))).toBe(false);
});

describe("commentsPayload", () => {
  const at = "2026-10-19T14:30:02.000Z";
  const question = {
    v: 1 as const,
    id: "c1",
    traceId: "T",
    rowId: "round:L:0",
    anchor: {},
    author: { kind: "human" as const, id: "adit" },
    text: "why twice?",
    created: at,
  };
  const answer = {
    ...question,
    id: "c2",
    author: { kind: "agent" as const, id: "claude" },
    text: "it retries",
    replyTo: "c1",
  };

  it("is empty with no threads and lists each thread with its replies indented", () => {
    expect(commentsPayload([])).toEqual([]);
    const lines = commentsPayload([{ comment: question, replies: [answer] }]);
    expect(lines[1]).toEqual({ kind: "rule", text: "COMMENTS · 1", tone: "accent" });
    expect(lines[2]).toMatchObject({ kind: "text", indent: 0 });
    expect((lines[2] as { text: string }).text).toContain("✎ adit");
    expect((lines[2] as { text: string }).text).toContain("why twice?");
    expect(lines[3]).toMatchObject({ kind: "text", indent: 1 });
    expect((lines[3] as { text: string }).text).toContain("⚑ claude");
  });

  it("is appended to a row's payload when the options carry threads", () => {
    const row = roundRow("answer text");
    const plain = payloadFor(row, { raw: false });
    const withComments = payloadFor(row, {
      raw: false,
      comments: [{ comment: question, replies: [] }],
    });
    expect(withComments.slice(0, plain.length)).toEqual(plain);
    expect(withComments.at(-1)).toMatchObject({ kind: "text" });
    expect((withComments.at(-1) as { text: string }).text).toContain("why twice?");
  });
});

describe("a round's reasoning", () => {
  function reasoningRow(completion: Record<string, unknown>): StoryRow {
    return outlineRows(
      buildForest([event("promptCompletion", 1000, "L", null, { completion })])[0],
      { machinery: false, admin: false },
    )[0];
  }

  function texts(row: StoryRow): string[] {
    return payloadFor(row, options).map((line) => ("text" in line ? String(line.text) : ""));
  }

  it("shows the model's reasoning above its reply", () => {
    const lines = texts(
      reasoningRow({ output: "Here is the answer.", reasoning: "Let me search" }),
    );
    const heading = lines.indexOf("REASONING");
    expect(heading).toBeGreaterThan(-1);
    expect(lines.findIndex((text) => text.includes("Let me search"))).toBeGreaterThan(heading);
    expect(lines.findIndex((text) => text.includes("Here is the answer."))).toBeGreaterThan(
      lines.findIndex((text) => text.includes("Let me search")),
    );
  });

  it("an empty reply with reasoning still shows the reasoning", () => {
    const lines = texts(reasoningRow({ output: null, toolCalls: [], reasoning: "Let me search" }));
    expect(lines).toContain("REASONING");
    expect(lines.some((text) => text.includes("Let me search"))).toBe(true);
  });

  it("a round without reasoning has no REASONING heading", () => {
    expect(texts(reasoningRow({ output: "hi" }))).not.toContain("REASONING");
  });
});
