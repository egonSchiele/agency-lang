import { describe, expect, it } from "vitest";
import {
  contentText,
  normalizeMessage,
  messagesOf as wireMessagesOf,
} from "../statelog/wireAccessors.js";
import { leaf, span, trace } from "./timeline/fixture.js";
import { roundsOf, type Round } from "./timeline/rounds.js";
import { messageKey, messagesOf, roundDeltas } from "./messageDelta.js";

const system = { role: "system", content: "write code" };
const user = { role: "user", content: "a module" };
function round(messages: unknown[], overrides: Partial<Round> = {}): Round {
  return {
    ...roundsOf(
      trace([
        span("llmCall", [leaf("promptCompletion", 1000, { messages, threadIdentity: "main" })], {
          id: "L",
        }),
      ]),
    )[0],
    ...overrides,
  };
}
describe("message deltas", () => {
  it("adds every first message, then only the appended occurrences", () => {
    const reply = { role: "tool", content: { errors: [], warnings: [] }, toolCallId: "one" };
    const deltas = roundDeltas([round([system, user]), round([system, user, reply])]);
    expect(deltas[0].added).toEqual([system, user]);
    expect(deltas[1].added).toEqual([reply]);
    expect(deltas[1].rewrite).toBeUndefined();
  });
  it("separates recorded and conservative legacy threads", () => {
    const rounds = [
      round([system]),
      round([user], { thread: { kind: "recorded", id: "child" } }),
      round([user], { thread: { kind: "legacy", id: "main" } }),
    ];
    expect(roundDeltas(rounds).every((delta) => delta.rewrite === undefined)).toBe(true);
  });
  it("reports a rewrite from the first changed message, with counts and context", () => {
    const summary = { role: "system", content: "summary" };
    expect(
      roundDeltas([
        round([system, user], { contextTokens: 184000 }),
        round([system, summary], { contextTokens: 31000 }),
      ])[1],
    ).toMatchObject({
      added: [summary],
      rewrite: {
        messagesBefore: 2,
        messagesAfter: 2,
        tokensBefore: 184000,
        tokensAfter: 31000,
        firstChangedAt: 1,
      },
    });
  });

  it("reports a shortened history as changed where the removed message was", () => {
    const call = { id: "c1", name: "subagent", arguments: {} };
    const asked = { role: "assistant", content: "", toolCalls: [call] };
    const resumed = { role: "user", content: "[subagent finished. answer]" };
    // A handoff drops its tool call from the assistant message that carried it.
    expect(roundDeltas([round([user, asked]), round([user, resumed])])[1]).toMatchObject({
      added: [resumed],
      rewrite: { messagesBefore: 2, messagesAfter: 2, firstChangedAt: 1 },
    });
  });

  it("treats a value and its JSON text as the same message, and two texts as different", () => {
    const records = [{ city: "Oslo" }, { city: "Rome" }];
    const asValue = { role: "tool", name: "cities", toolCallId: "c1", content: records };
    const asText = {
      role: "tool",
      name: "cities",
      toolCallId: "c1",
      content: JSON.stringify(records),
    };
    expect(messageKey(asValue)).toBe(messageKey(asText));
    expect(messageKey({ role: "user", content: "a" })).not.toBe(
      messageKey({ role: "user", content: "b" }),
    );
    expect(roundDeltas([round([user, asValue]), round([user, asText, system])])[1]).toMatchObject({
      added: [system],
    });
    expect(
      roundDeltas([round([user, asValue]), round([user, asText, system])])[1].rewrite,
    ).toBeUndefined();
  });
  it("compares full image contents and tool request identities, ignoring labels", () => {
    const image = { role: "user", content: [{ type: "image", url: "a" }] };
    expect(
      roundDeltas([
        round([image]),
        round([{ ...image, content: [{ type: "image", url: "b" }] }]),
      ])[1].rewrite,
    ).toBeDefined();
    expect(
      roundDeltas([round([{ ...user, label: "old" }]), round([{ ...user, label: "new" }])])[1]
        .added,
    ).toEqual([]);
    const request = {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "one", name: "read", arguments: { path: "a" } }],
    };
    expect(
      roundDeltas([
        round([request]),
        round([{ ...request, toolCalls: [{ ...request.toolCalls[0], id: "two" }] }]),
      ])[1].rewrite,
    ).toBeDefined();
  });
  it("normalizes provider spellings without dropping arguments or request ids", () => {
    const message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "one", function: { name: "read", arguments: '{"path":"a"}' } }],
      tool_call_id: "reply",
    };
    expect(normalizeMessage(message)).toEqual({
      role: "assistant",
      content: null,
      toolCalls: [{ id: "one", name: "read", arguments: '{"path":"a"}' }],
      toolCallId: "reply",
    });
    expect(messagesOf(round([message]))).toEqual([normalizeMessage(message)]);
    expect(wireMessagesOf(leaf("promptCompletion", 0).event!)).toEqual([]);
  });
  it("displays text parts, plain objects, scalar replies and data arrays", () => {
    expect(
      contentText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
    expect(contentText({ errors: [], warnings: [] })).toBe('{"errors":[],"warnings":[]}');
    expect(contentText(42)).toBe("42");
    expect(contentText([1, 2])).toBe("[1,2]");
    expect(contentText(null)).toBe("");
  });
});
