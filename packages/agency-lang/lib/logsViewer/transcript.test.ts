import { describe, expect, it } from "vitest";
import { event, sampleRunForest } from "./storyFixture.js";
import { buildForest } from "./tree.js";
import { completionMessageOf } from "../statelog/wireAccessors.js";
import { consumeRepresented, transcriptBlocks, transcriptText } from "./transcript.js";
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
    const pending: WireMessage[] = [{ role: "assistant", content: "same" }];
    expect(consumeRepresented(pending[0], pending)).toBe(true);
    expect(consumeRepresented({ role: "assistant", content: "same" }, pending)).toBe(false);
  });
  it.each([
    "result [attachment: image]",
    "res\n\n[tool result truncated: showing 3 of 6 chars]",
    { errors: [], warnings: [] },
    42,
  ])("retains a reply that differs from a recorded result: %j", (output) => {
    expect(
      transcriptBlocks(conversation([], output)).filter((block) => block.kind === "history"),
    ).toHaveLength(1);
  });
  it("accepts one successful Result wrapper and conservatively retains nested wrappers", () => {
    expect(
      transcriptBlocks(
        conversation([], { __type: "resultType", success: true, value: "result" }),
      ).filter((block) => block.kind === "history"),
    ).toHaveLength(0);
    expect(
      transcriptBlocks(
        conversation([], {
          __type: "resultType",
          success: true,
          value: { __type: "resultType", success: true, value: "result" },
        }),
      ).filter((block) => block.kind === "history"),
    ).toHaveLength(1);
  });
  it("does not assign identical repeated requests to one result", () => {
    expect(
      transcriptBlocks(conversation([], "result", [request, { ...request, id: "other" }]))
        .filter((block) => block.kind === "history")
        .map((block) => block.text),
    ).toContain("result");
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
        label: compaction ? "CONTEXT COMPACTED" : "HISTORY REWRITTEN",
        messagesBefore: 2,
        messagesAfter: 3,
        tokensBefore: 184000,
        tokensAfter: 31000,
      });
      expect(blocks.filter((block) => block.kind === "system").map((block) => block.text)).toEqual([
        "write code",
        "summary of earlier work",
      ]);
      expect(blocks.filter((block) => block.kind === "history").map((block) => block.text)).toEqual(
        ["same"],
      );
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

it.each([
  { requested: { path: "a", limit: null }, recorded: { path: "a" } },
  { requested: { limit: 1, path: "a" }, recorded: { path: "a", limit: 1 } },
  {
    requested: { options: { limit: 1, path: "a" } },
    recorded: { options: { path: "a", limit: 1 } },
  },
])("pairs normalized arguments without repeating the tool reply: %j", (options) => {
  expect(
    transcriptBlocks(toolConversation(options)).filter((block) => block.kind === "history"),
  ).toHaveLength(0);
});

it.each([
  { requested: { path: "a" }, recorded: { path: "a", required: null } },
  { requested: { path: "a", required: null }, recorded: { path: "a", required: "value" } },
  { requested: { options: { limit: null } }, recorded: { options: {} } },
])("retains replies with different required or nested arguments: %j", (options) => {
  expect(
    transcriptBlocks(toolConversation(options)).filter((block) => block.kind === "history"),
  ).toHaveLength(1);
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
  { compactionSpan: "A", data: { threadIdentity: "a" }, expected: "HISTORY REWRITTEN" },
  { compactionSpan: "A", data: {}, expected: "HISTORY REWRITTEN" },
  { compactionSpan: "B", data: {}, expected: "CONTEXT COMPACTED" },
  { compactionSpan: "B", data: { threadIdentity: "a" }, expected: "HISTORY REWRITTEN" },
  { compactionSpan: "B", data: { threadId: "wrong" }, expected: "HISTORY REWRITTEN" },
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
