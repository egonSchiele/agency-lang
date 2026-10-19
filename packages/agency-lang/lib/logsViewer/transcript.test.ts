import { describe, expect, it } from "vitest";
import { event, sampleRunForest } from "./storyFixture.js";
import { buildForest } from "./tree.js";
import { completionMessageOf } from "../statelog/wireAccessors.js";
import { represents, transcriptBlocks, transcriptText } from "./transcript.js";
import { transcriptPayload } from "./transcriptPayload.js";
import type { WireMessage } from "./messageDelta.js";
const system = { role: "system", content: "write code" };
const user = { role: "user", content: "a module" };
const request = { id: "call", name: "read", arguments: { path: "a" } };
const assistant = { role: "assistant", content: "same answer", toolCalls: [request] };
const reply = { role: "tool", name: "read", tool_call_id: "call", content: "result" };
function conversation(extra: unknown[] = [], output: unknown = "result", calls = [request]) {
  return buildForest([
    event("promptCompletion", 100, "L", null, {
      threadIdentity: "main",
      messages: [system, user],
      completion: { output: "same answer", toolCalls: calls },
    }),
    event("toolCallStart", 101, "tool", "L", { toolName: "read", args: { path: "a" } }),
    event("interruptResolved", 102, "tool", "L", {
      interruptId: "read",
      outcome: "approved",
      interrupt: { effect: "std::read" },
    }),
    event("toolCall", 106, "tool", "L", { toolName: "read", output, timeTaken: 5 }),
    event("promptCompletion", 200, "L", null, {
      threadIdentity: "main",
      messages: [system, user, assistant, { ...reply }, ...extra],
      completion: { output: "done" },
    }),
  ])[0];
}
describe("transcript blocks", () => {
  it("reads in conversation order, pairing exact tool replies and interrupts", () => {
    const blocks = transcriptBlocks(conversation());
    expect(blocks.map((block) => block.kind)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(blocks.find((block) => block.kind === "tool")).toMatchObject({
      output: "result",
      outputLines: 1,
      interrupts: [{ effect: "std::read", outcome: "approved" }],
    });
  });
  it("does not repeat the caller's request when a sub-agent on the same thread runs between its calls", () => {
    const ask = { id: "r", name: "researchAgent", arguments: {} };
    const asked = { role: "assistant", content: "", toolCalls: [ask] };
    const answer = { role: "tool", name: "researchAgent", tool_call_id: "r", content: "found it" };
    const blocks = transcriptBlocks(
      buildForest([
        event("promptCompletion", 100, "A", null, {
          threadIdentity: "main",
          messages: [user],
          completion: { output: "", toolCalls: [ask] },
        }),
        event("toolCallStart", 101, "t", "A", { toolName: "researchAgent", args: {} }),
        event("promptCompletion", 150, "B", "t", {
          threadIdentity: "main",
          messages: [user, asked, { role: "user", content: "research this" }],
          completion: { output: "found it" },
        }),
        event("toolCall", 160, "t", "A", { toolName: "researchAgent", output: "found it" }),
        event("promptCompletion", 300, "A", null, {
          threadIdentity: "main",
          messages: [user, asked, answer],
          completion: { output: "done" },
        }),
      ])[0],
    );
    // The sub-agent's calls get their own thread row, as on the trace,
    // though they ran on the caller's thread.
    expect(blocks.map((block) => `${block.depth} ${block.kind}`)).toEqual([
      "0 thread",
      "0 user",
      "0 assistant",
      "0 tool",
      "1 thread",
      "1 user",
      "1 assistant",
      "0 assistant",
    ]);
  });
  it("consumes only one identical occurrence and retains refusals", () => {
    const blocks = transcriptBlocks(
      conversation([
        assistant,
        { role: "tool", content: "Call rejected", tool_call_id: "refused" },
      ]),
    );
    expect(blocks.filter((block) => block.kind === "history").map((block) => block.text)).toEqual([
      expect.stringContaining("same answer"),
      "Call rejected",
    ]);
  });
  it("represents a message by its key, a handoff's kept text, or a reply's call id", () => {
    const shown: WireMessage = { role: "assistant", content: "same", toolCalls: [request] };
    expect(represents(shown, { ...shown })).toBe(true);
    // A handoff leaves the completion's text in the history with the call
    // that dispatched it removed; a different text is another message.
    expect(represents(shown, { role: "assistant", content: "same" })).toBe(true);
    expect(represents(shown, { role: "assistant", content: "other" })).toBe(false);
    expect(represents({ role: "assistant", content: "same" }, shown)).toBe(false);
    const reply: WireMessage = { role: "tool", toolCallId: "call", content: "result" };
    expect(represents(reply, { ...reply, content: "result [attachment: image]" })).toBe(true);
    expect(represents(reply, { ...reply, toolCallId: "other" })).toBe(false);
    expect(represents({ role: "tool", content: "x" }, { role: "tool", content: "x" })).toBe(true);
  });
  it.each([
    "result [attachment: image]",
    "res\n\n[tool result truncated: showing 3 of 6 chars]",
    { errors: [], warnings: [] },
    42,
  ])("lays a reply that differs from the recorded result beside the tool block: %j", (output) => {
    const blocks = transcriptBlocks(conversation([], output));
    expect(blocks.filter((block) => block.kind === "history")).toHaveLength(0);
    expect(blocks.find((block) => block.kind === "tool")).toMatchObject({ modelSaw: "result" });
  });
  it("notes what the model read only when it differs from the recorded result", () => {
    const plain = transcriptBlocks(
      conversation([], { __type: "resultType", success: true, value: "result" }),
    );
    expect(plain.filter((block) => block.kind === "history")).toHaveLength(0);
    expect(plain.find((block) => block.kind === "tool")).toMatchObject({ modelSaw: undefined });
    const nested = transcriptBlocks(
      conversation([], {
        __type: "resultType",
        success: true,
        value: { __type: "resultType", success: true, value: "result" },
      }),
    );
    expect(nested.filter((block) => block.kind === "history")).toHaveLength(0);
    expect(nested.find((block) => block.kind === "tool")).toMatchObject({ modelSaw: "result" });
  });
  it("pairs identical repeated requests with the tools by position, as the trace does", () => {
    expect(
      transcriptBlocks(conversation([], "result", [request, { ...request, id: "other" }])).filter(
        (block) => block.kind === "history",
      ),
    ).toHaveLength(0);
  });
  it("retains seeded messages and identical text on independent recorded threads", () => {
    const trace = buildForest([
      event("promptCompletion", 100, "L", null, {
        threadIdentity: "main",
        messages: [
          { role: "assistant", content: "seed" },
          { role: "tool", content: { errors: [], warnings: [] }, tool_call_id: "seed" },
        ],
        completion: { output: "same" },
      }),
      event("promptCompletion", 200, "child", null, {
        threadIdentity: "child",
        messages: [{ role: "assistant", content: "same" }],
        completion: { output: "child" },
      }),
    ])[0];
    expect(
      transcriptBlocks(trace)
        .filter((block) => block.kind === "history")
        .map((block) => block.text),
    ).toEqual(["seed", '{"errors":[],"warnings":[]}', "same"]);
  });
  it.each([true, false])(
    "keeps rewritten replacement history and a system summary (compaction %s)",
    (compaction) => {
      const events = [
        event("promptCompletion", 100, "L", null, {
          threadIdentity: "main",
          messages: [system, user],
          completion: { output: "same" },
          usage: { inputTokens: 184000 },
        }),
      ];
      if (compaction) {
        events.push(event("memoryCompaction", 150, "L"));
      }
      events.push(
        event("promptCompletion", 200, "L", null, {
          threadIdentity: "main",
          messages: [
            system,
            { role: "system", content: "summary of earlier work" },
            { role: "assistant", content: "same" },
          ],
          completion: { output: "done" },
          usage: { inputTokens: 31000 },
        }),
      );
      const blocks = transcriptBlocks(buildForest(events)[0]);
      expect(blocks.find((block) => block.kind === "rewrite")).toMatchObject({
        label: compaction ? "CONTEXT COMPACTED" : "HISTORY CHANGED",
        messagesBefore: 2,
        messagesAfter: 3,
        tokensBefore: 184000,
        tokensAfter: 31000,
      });
      expect(blocks.filter((block) => block.kind === "system").map((block) => block.text)).toEqual([
        "write code",
        "summary of earlier work",
      ]);
      // The messages compaction kept were shown already and are not repeated.
      expect(blocks.filter((block) => block.kind === "history")).toEqual([]);
    },
  );
  it("gives distinct stable system IDs per thread and full input position", () => {
    const events = [
      event("promptCompletion", 100, "L", null, {
        threadIdentity: "main",
        messages: [system, user, { role: "system", content: "second" }],
      }),
      event("promptCompletion", 200, "child", null, {
        threadIdentity: "child",
        messages: [system],
      }),
    ];
    const before = transcriptBlocks(buildForest(events)[0]);
    events.push(
      event("promptCompletion", 300, "L", null, {
        threadIdentity: "main",
        messages: [
          system,
          user,
          { role: "system", content: "second" },
          { role: "system", content: "third" },
        ],
      }),
    );
    const after = transcriptBlocks(buildForest(events)[0]);
    expect(before.filter((block) => block.kind === "system").map((block) => block.id)).toEqual([
      "system:round:L:0:0",
      "system:round:L:0:2",
      "system:round:child:0:0",
    ]);
    expect(after.slice(0, before.length).map((block) => block.id)).toEqual(
      before.map((block) => block.id),
    );
  });
  it("decodes the real final answer and retains one system prompt", () => {
    const blocks = transcriptBlocks(sampleRunForest()[0]);
    expect(blocks.filter((block) => block.kind === "system")).toHaveLength(1);
    expect(blocks.filter((block) => block.kind === "assistant").at(-1)).toMatchObject({
      structured: { response: { code: expect.stringContaining("def archiveNotes") } },
    });
  });
});
it("accesses current and historical completions without discarding tool requests", () => {
  expect(
    completionMessageOf(
      event("promptCompletion", 0, "L", null, { completion: { output: "", toolCalls: [request] } }),
    ),
  ).toEqual({ role: "assistant", content: "", toolCalls: [request] });
  expect(
    completionMessageOf(
      event("promptCompletion", 0, "L", null, {
        completion: {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call", function: { name: "read", arguments: '{"path":"a"}' } }],
              },
            },
          ],
        },
      }),
    ),
  ).toMatchObject({
    content: null,
    toolCalls: [{ id: "call", name: "read", arguments: '{"path":"a"}' }],
  });
});

it.each([
  { errors: [], warnings: [] },
  42,
  { __type: "resultType", success: true, value: "nested" },
])("suppresses an exact model-visible object or scalar reply once: %j", (content) => {
  const trace = conversation([], { __type: "resultType", success: true, value: content });
  const last = transcriptBlocks(trace)
    .filter((block) => block.kind === "assistant")
    .at(-1)!;
  last.round.node.event!.data.messages[3].content = content;
  expect(transcriptBlocks(trace).filter((block) => block.kind === "history")).toHaveLength(0);
});

it("does not suppress equal text with a different name, ID or tool arguments", () => {
  const trace = conversation([
    { ...assistant, toolCalls: [{ ...request, arguments: { path: "b" } }] },
    { ...reply, tool_call_id: "another" },
    { ...reply, name: "other" },
  ]);
  expect(transcriptBlocks(trace).filter((block) => block.kind === "history")).toHaveLength(3);
});

it("includes owned terminal errors and shared status text in tool search and copy", () => {
  const trace = buildForest([
    event("promptCompletion", 100, "L"),
    event("toolCallStart", 101, "write", "L", { toolName: "write", args: { path: "a" } }),
    event("toolCallStart", 102, "nested", "write", { toolName: "nested" }),
    event("error", 103, "nested", "write", {
      message: "nested failure only",
      destructiveRan: true,
    }),
    event("error", 104, "write", "L", { message: "disk quota exceeded", destructiveRan: true }),
  ])[0];
  const block = transcriptBlocks(trace).find((block) => block.id === "write")!;
  expect(transcriptText(block)).toContain("disk quota exceeded");
  expect(transcriptText(block)).toContain("tool failed; work occurred before it stopped");
  expect(transcriptText(block)).not.toContain("nested failure only");
});

function toolConversation(options: {
  requested: Record<string, unknown>;
  recorded: Record<string, unknown>;
  output?: unknown;
  reply?: unknown;
  toolCallId?: string;
  duplicate?: boolean;
}) {
  const call = { id: "call", name: "read", arguments: options.requested };
  const calls = options.duplicate ? [call, { ...call, id: "other" }] : [call];
  const answer = { role: "assistant", content: "answer", toolCalls: calls };
  return buildForest([
    event("promptCompletion", 100, "L", null, {
      threadIdentity: "main",
      messages: [user],
      completion: { output: "answer", toolCalls: calls },
    }),
    event("toolCallStart", 101, "tool", "L", {
      toolName: "read",
      args: options.recorded,
    }),
    event("toolCall", 105, "tool", "L", {
      toolName: "read",
      args: options.recorded,
      toolCallId: options.toolCallId,
      output: options.output ?? "result",
    }),
    event("promptCompletion", 200, "L", null, {
      threadIdentity: "main",
      messages: [user, answer, { ...reply, content: options.reply ?? "result" }],
      completion: { output: "done" },
    }),
  ])[0];
}

// A tool with no recorded call id pairs with the request of its name at its
// position in the round, whatever the recorded arguments: the runtime fills
// in defaults and drops nulls, so the arguments seldom match exactly.
it.each([
  { requested: { path: "a", limit: null }, recorded: { path: "a" } },
  { requested: { limit: 1, path: "a" }, recorded: { path: "a", limit: 1 } },
  {
    requested: { options: { limit: 1, path: "a" } },
    recorded: { options: { path: "a", limit: 1 } },
  },
  { requested: { path: "a" }, recorded: { path: "a", required: null } },
  { requested: { path: "a", required: null }, recorded: { path: "a", required: "value" } },
  { requested: { options: { limit: null } }, recorded: { options: {} } },
])("pairs a reply by position without repeating it, for arguments %j", (options) => {
  expect(
    transcriptBlocks(toolConversation(options)).filter((block) => block.kind === "history"),
  ).toHaveLength(0);
});

it("uses the recorded call ID to distinguish identical requests", () => {
  const trace = toolConversation({
    requested: { path: "a" },
    recorded: { path: "a" },
    toolCallId: "call",
    duplicate: true,
  });
  expect(transcriptBlocks(trace).filter((block) => block.kind === "history")).toHaveLength(0);
});

it("does not fall back to arguments when a recorded call ID disagrees", () => {
  const trace = toolConversation({
    requested: { path: "a" },
    recorded: { path: "a" },
    toolCallId: "different",
  });
  expect(transcriptBlocks(trace).filter((block) => block.kind === "history")).toHaveLength(1);
});

it.each([null, undefined])("suppresses the successful void reply once: %j", (value) => {
  const trace = toolConversation({
    requested: { path: "a" },
    recorded: { path: "a" },
    output: { __type: "resultType", success: true, value },
    reply: "read ran successfully but did not return a value",
  });
  const blocks = transcriptBlocks(trace);
  expect(blocks.filter((block) => block.kind === "history")).toHaveLength(0);
  expect(blocks.find((block) => block.kind === "tool")).toMatchObject({
    output: "read ran successfully but did not return a value",
  });
});

it.each([
  { compactionSpan: "A", data: { threadIdentity: "a" }, expected: "HISTORY CHANGED" },
  { compactionSpan: "A", data: {}, expected: "HISTORY CHANGED" },
  { compactionSpan: "B", data: {}, expected: "CONTEXT COMPACTED" },
  { compactionSpan: "B", data: { threadIdentity: "a" }, expected: "HISTORY CHANGED" },
  { compactionSpan: "B", data: { threadId: "wrong" }, expected: "HISTORY CHANGED" },
  { compactionSpan: "B", data: { threadId: "0" }, expected: "CONTEXT COMPACTED" },
])("attributes compaction to its own thread: %j", ({ compactionSpan, data, expected }) => {
  const trace = buildForest([
    event("promptCompletion", 90, "A", null, {
      threadIdentity: "a",
      threadId: "0",
      messages: [user],
    }),
    event("promptCompletion", 100, "B", null, {
      threadIdentity: "b",
      threadId: "0",
      messages: [user],
    }),
    event("memoryCompaction", 150, "compact", compactionSpan, data),
    event("promptCompletion", 200, "B", null, {
      threadIdentity: "b",
      threadId: "0",
      messages: [system],
    }),
  ])[0];
  expect(transcriptBlocks(trace).find((block) => block.kind === "rewrite")).toMatchObject({
    label: expected,
  });
});

describe("error blocks", () => {
  function run() {
    return buildForest([
      event("promptCompletion", 100, "L", null, {
        threadIdentity: "main",
        messages: [user],
        completion: { output: "same answer", toolCalls: [request] },
      }),
      event("toolCallStart", 101, "tool", "L", { toolName: "read", args: { path: "a" } }),
      event("error", 102, "tool", "L", { message: "no such file", errorType: "toolError" }),
      event("error", 150, "L", null, { message: "validator failed", errorType: "runtimeError" }),
      event("error", 151, null, null, { message: "validator failed", errorType: "runtimeError" }),
      event("promptCompletion", 200, "L", null, {
        threadIdentity: "main",
        messages: [user, assistant, { ...reply, content: "Error: no such file" }],
        completion: { output: "done" },
      }),
    ])[0];
  }

  it("places an error outside a tool by time on its thread, folded with its rethrow", () => {
    const blocks = transcriptBlocks(run());
    // The failed tool's reply is laid beside its block, not shown again.
    expect(blocks.map((block) => block.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "error",
      "assistant",
    ]);
    expect(blocks.find((block) => block.kind === "tool")).toMatchObject({
      modelSaw: "Error: no such file",
    });
    const error = blocks.find((block) => block.kind === "error");
    expect(error).toMatchObject({ error: { message: "validator failed", count: 2 }, at: 150 });
    expect(transcriptText(error!)).toBe("validator failed");
  });

  it("keeps an error inside a tool on the tool block, with the tool marked failed", () => {
    const tool = transcriptBlocks(run()).find((block) => block.kind === "tool");
    expect(tool).toMatchObject({ row: { status: "failed" } });
    expect(transcriptText(tool!)).toContain("no such file");
  });
});

describe("thread dividers", () => {
  const call = (span: string, at: number, label: string, parent: string | null = null) =>
    event("promptCompletion", at, span, parent, {
      threadIdentity: span,
      threadLabel: label,
      messages: [{ role: "user", content: `hi ${span}` }],
      completion: { output: `ok ${span}` },
    });

  it("divides the transcript where the thread changes and indents by tool depth", () => {
    const blocks = transcriptBlocks(
      buildForest([
        call("main", 100, "mainConversation"),
        event("toolCallStart", 101, "tool", "main", { toolName: "subagent", args: {} }),
        call("inner", 150, "subagent", "tool"),
        event("toolCall", 160, "tool", "main", { toolName: "subagent", output: "done" }),
        call("main", 300, "mainConversation"),
      ])[0],
    );
    // The tool block sits with the call that requested it, before the
    // sub-agent's thread it started; the main thread resumes after with
    // no second row, as on the trace, where it is one group.
    expect(blocks.map((block) => `${block.depth} ${block.kind}`)).toEqual([
      "0 thread",
      "0 user",
      "0 assistant",
      "0 tool",
      "1 thread",
      "1 user",
      "1 assistant",
      "0 assistant",
    ]);
    expect(blocks.filter((block) => block.kind === "thread")).toMatchObject([
      { label: "mainConversation", calls: 2, tool: undefined, id: "group:main" },
      { label: "subagent", calls: 1, tool: "subagent", complete: true, id: "group:inner" },
    ]);
  });

  it("lets an error with no thread of its own join the thread it lands beside", () => {
    const blocks = transcriptBlocks(
      buildForest([
        call("main", 100, "mainConversation"),
        call("check", 200, "expressionCheck"),
        event("error", 250, null, null, { message: "hook failed", errorType: "runtimeError" }),
        call("main", 300, "mainConversation"),
      ])[0],
    );
    expect(blocks.filter((block) => block.kind === "thread").map((block) => block.label)).toEqual([
      "mainConversation",
      "expressionCheck",
    ]);
    expect(blocks.find((block) => block.kind === "error")).toMatchObject({
      threadLabel: "mainConversation",
    });
  });

  it("adds no divider to a transcript on one thread", () => {
    const blocks = transcriptBlocks(buildForest([call("main", 100, "mainConversation")])[0]);
    expect(blocks.some((block) => block.kind === "thread")).toBe(false);
  });
});

describe("rewrite headings", () => {
  const round = (at: number, messages: unknown[]) =>
    event("promptCompletion", at, "L", null, {
      threadIdentity: "main",
      messages,
      completion: { output: "ok" },
    });
  const heading = (blocks: ReturnType<typeof transcriptBlocks>) =>
    transcriptPayload(
      blocks.find((block) => block.kind === "rewrite")!,
      false,
    )[0];

  it("says where the history changed", () => {
    const blocks = transcriptBlocks(
      buildForest([round(100, [system, user]), round(200, [system, { ...user, content: "b" }])])[0],
    );
    expect(heading(blocks)).toMatchObject({ text: expect.stringContaining("from message 2") });
  });

  it("says where a shortened history was cut", () => {
    const blocks = transcriptBlocks(
      buildForest([round(100, [system, user]), round(200, [system])])[0],
    );
    expect(heading(blocks)).toMatchObject({ text: expect.stringContaining("after message 1") });
  });
});

describe("pause blocks", () => {
  it("marks where the run paused and how long it waited", () => {
    const blocks = transcriptBlocks(
      buildForest([
        event("agentStart", 0, "run1", null, { entryNode: "main" }),
        event("promptCompletion", 100, "L", "run1", {
          threadIdentity: "main",
          messages: [user],
          completion: { toolCalls: [{ name: "deploy" }] },
        }),
        event("toolCallStart", 101, "tool", "L", { toolName: "deploy", args: {} }),
        event("interruptResolved", 103, "tool", "L", { interruptId: "i1", outcome: "passed" }),
        event("agentStart", 7_103, "run2", null, { entryNode: "main" }),
        event("interruptResolved", 7_104, "run2", null, {
          interruptId: "i1",
          outcome: "approved",
          resolvedBy: "user",
        }),
        event("toolCall", 7_200, "tool", "L", { toolName: "deploy", output: "ok" }),
        event("promptCompletion", 7_300, "L", "run1", {
          threadIdentity: "main",
          messages: [
            user,
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c", name: "deploy", arguments: {} }],
            },
          ],
          completion: { output: "done" },
        }),
      ])[0],
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "pause",
      "history",
      "assistant",
    ]);
    const pause = blocks.find((block) => block.kind === "pause");
    expect(pause).toMatchObject({ pausedMs: 7_001, resumed: true, at: 103 });
    expect(transcriptText(pause!)).toBe("paused, then resumed");
  });
});

describe("decision calls", () => {
  it("shows a decision call as one block with the questions and answers, not as a chat", () => {
    const decision = {
      state: [{ role: "user", content: "Are you able to set up a recurring job?" }],
      questions: {
        response: {
          type: "choice",
          instructions: "Which expression?",
          criteria: { idle: "i", curious: "c" },
        },
      },
      answers: {
        response: {
          type: "choice",
          choice: "curious",
          confidence: 0.7,
          probabilities: { curious: 0.86, idle: 0.14 },
        },
      },
    };
    const blocks = transcriptBlocks(
      buildForest([
        event("promptCompletion", 100, "L", null, {
          threadIdentity: "check",
          usageKind: "decision",
          messages: [{ role: "user", content: "Are you able to set up a recurring job?" }],
          completion: { output: JSON.stringify({ response: "curious" }) },
          decision,
        }),
      ])[0],
    );
    expect(blocks.map((block) => block.kind)).toEqual(["assistant"]);
    const lines = transcriptPayload(blocks[0], false).map((line) =>
      "text" in line ? line.text : "",
    );
    expect(lines).toContain("QUESTIONS");
    expect(lines).toContain("Which expression?");
    expect(lines).toContain("ANSWER · response");
    expect(lines).toContain("curious 86%");
  });
});

describe("a handoff on the caller's thread", () => {
  /** The caller dispatches `researchAgent`, whose calls land on the same
   *  thread; on return its system prompt is stripped and a hand-back user
   *  message is pushed. */
  function handoff() {
    const ask = { id: "r", name: "researchAgent", arguments: { userMsg: "look it up" } };
    const kept = { role: "assistant", content: "I will dispatch a researcher." };
    const research = { role: "system", content: "You are a research analyst." };
    const prompt = { role: "user", content: "look it up" };
    const search = { id: "s", name: "search", arguments: { query: "q" } };
    const searched = { role: "assistant", content: "", toolCalls: [search] };
    const found = { role: "tool", name: "search", tool_call_id: "s", content: "hits" };
    const back = { role: "user", content: "[researchAgent finished. found it]\nContinue." };
    return buildForest([
      event("promptCompletion", 100, "A", null, {
        threadIdentity: "main",
        threadLabel: "main",
        messages: [user],
        completion: { output: "I will dispatch a researcher.", toolCalls: [ask] },
      }),
      event("toolCallStart", 101, "t", "A", { toolName: "researchAgent", args: ask.arguments }),
      event("promptCompletion", 150, "B", "t", {
        threadIdentity: "main",
        threadLabel: "main",
        messages: [user, kept, research, prompt],
        completion: { output: "", toolCalls: [search] },
      }),
      event("toolCallStart", 151, "s1", "B", { toolName: "search", args: { query: "q" } }),
      event("toolCall", 152, "s1", "B", { toolName: "search", output: "hits" }),
      event("promptCompletion", 200, "B", "t", {
        threadIdentity: "main",
        threadLabel: "main",
        messages: [user, kept, research, prompt, searched, found],
        completion: { output: "found it" },
      }),
      event("toolCall", 210, "t", "A", { toolName: "researchAgent", output: "found it" }),
      event("promptCompletion", 300, "A", null, {
        threadIdentity: "main",
        threadLabel: "main",
        messages: [
          user,
          kept,
          prompt,
          searched,
          found,
          { role: "assistant", content: "found it" },
          back,
        ],
        completion: { output: "done" },
      }),
    ])[0];
  }
  it("shows the sub-agent's work once, names its prompt, and marks the hand-back", () => {
    const blocks = transcriptBlocks(handoff());
    expect(blocks.map((block) => `${block.depth} ${block.kind}`)).toEqual([
      "0 thread",
      "0 user",
      "0 assistant",
      "0 tool",
      "1 thread",
      "1 system",
      "1 user",
      "1 assistant",
      "1 tool",
      "1 assistant",
      "0 handback",
      "0 assistant",
    ]);
    expect(blocks[1]).toMatchObject({ promptTo: undefined });
    expect(blocks[6]).toMatchObject({ promptTo: "researchAgent", text: "look it up" });
    expect(blocks.find((block) => block.kind === "handback")).toMatchObject({
      tool: "researchAgent",
    });
    expect(blocks.find((block) => block.kind === "rewrite")).toBeUndefined();
  });
});

describe("tools without recorded call ids", () => {
  it("pairs each reply with the same-named tool at its position in the round", () => {
    const first = { id: "a", name: "search", arguments: { query: "one" } };
    const second = { id: "b", name: "search", arguments: { query: "two" } };
    const blocks = transcriptBlocks(
      buildForest([
        event("promptCompletion", 100, "L", null, {
          threadIdentity: "main",
          messages: [user],
          completion: { output: "", toolCalls: [first, second] },
        }),
        // The runtime filled in a default the model never sent.
        event("toolCallStart", 101, "t1", "L", {
          toolName: "search",
          args: { query: "one", count: 8 },
        }),
        event("toolCall", 102, "t1", "L", { toolName: "search", output: "hits one" }),
        event("toolCallStart", 103, "t2", "L", {
          toolName: "search",
          args: { query: "two", count: 8 },
        }),
        event("toolCall", 104, "t2", "L", { toolName: "search", output: "hits two" }),
        event("promptCompletion", 200, "L", null, {
          threadIdentity: "main",
          messages: [
            user,
            { role: "assistant", content: "", toolCalls: [first, second] },
            { role: "tool", name: "search", tool_call_id: "a", content: "hits one" },
            { role: "tool", name: "search", tool_call_id: "b", content: "hits two" },
          ],
          completion: { output: "done" },
        }),
      ])[0],
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
  });
});

describe("turns", () => {
  function session() {
    const call = (span: string, at: number, messages: unknown[], output: string) =>
      event("promptCompletion", at, span, null, {
        threadIdentity: "main",
        threadLabel: "main",
        timeTaken: 1_000,
        messages,
        completion: { output },
        cost: { totalCost: 0.01 },
      });
    const first = { role: "user", content: "first question" };
    const second = { role: "user", content: "second question" };
    return buildForest([
      event("turnStart", 0, null, null, { message: "first question" }),
      call("L1", 5_000, [first], "one"),
      event("turnStart", 600_000, null, null, { message: "second question" }),
      call("L2", 605_000, [first, { role: "assistant", content: "one" }, second], "two"),
      event("promptCompletion", 606_000, "T", null, {
        threadIdentity: "title",
        threadLabel: "sessionTitle",
        timeTaken: 500,
        messages: [{ role: "user", content: "Write a title for this conversation" }],
        completion: { output: "Two questions" },
      }),
    ])[0];
  }
  it("opens each of the person's messages with a turn block carrying the wait before it", () => {
    const blocks = transcriptBlocks(session());
    // Each turn's llm() is its own span, so each gets a thread row, as on
    // the trace.
    expect(blocks.map((block) => block.kind)).toEqual([
      "thread",
      "turn",
      "user",
      "assistant",
      "thread",
      "turn",
      "user",
      "assistant",
      "thread",
      "user",
      "assistant",
    ]);
    expect(blocks[1]).toMatchObject({ waitedMs: undefined, turn: { index: 0 } });
    expect(blocks[5]).toMatchObject({ waitedMs: 595_000, turn: { index: 1 } });
    // The person's messages are the turn starts; the helper's prompt is not.
    expect(blocks[2]).toMatchObject({ promptTo: undefined });
    expect(blocks.filter((block) => block.kind === "user").at(-1)).toMatchObject({
      promptTo: "sessionTitle",
    });
    expect(
      transcriptPayload(blocks[5], false).map((line) => ("text" in line ? line.text : "")),
    ).toEqual([
      "⏸ waited 9m55s for the user",
      "══ TURN 2 · second question ══",
      "ran 6.0s · 2 LLM calls · $0.010",
    ]);
  });
  it("adds no turn blocks to a trace with one turn", () => {
    const one = buildForest([
      event("promptCompletion", 100, "L", null, { messages: [user], completion: { output: "x" } }),
    ])[0];
    expect(transcriptBlocks(one).some((block) => block.kind === "turn")).toBe(false);
  });
});

it("counts the LLM calls a thread divider opens", () => {
  const blocks = transcriptBlocks(
    buildForest([
      event("promptCompletion", 100, "L", null, {
        threadIdentity: "a",
        threadLabel: "main",
        messages: [user],
        completion: { output: "1" },
      }),
      event("promptCompletion", 200, "L", null, {
        threadIdentity: "a",
        threadLabel: "main",
        messages: [user, { role: "assistant", content: "1" }],
        completion: { output: "2" },
      }),
      event("promptCompletion", 300, "R", null, {
        threadIdentity: "b",
        threadLabel: "review",
        messages: [user],
        completion: { output: "ok" },
      }),
    ])[0],
  );
  const dividers = blocks.filter((block) => block.kind === "thread");
  expect(
    dividers.map((block) => (block.kind === "thread" ? [block.label, block.calls] : [])),
  ).toEqual([
    ["main", 2],
    ["review", 1],
  ]);
  expect(transcriptPayload(dividers[0], false)[0]).toMatchObject({
    text: "══ THREAD · main · 2 LLM calls ══",
  });
});
