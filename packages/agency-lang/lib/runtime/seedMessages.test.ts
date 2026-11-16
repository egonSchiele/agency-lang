import { describe, expect, it } from "vitest";
import * as smoltalk from "smoltalk";
import { seedFirstThread, seedFrom } from "./seedMessages.js";
import { ThreadStore } from "./state/threadStore.js";

const user = (text: string) => smoltalk.userMessage(text).toJSON();
const assistant = (text: string, callIds: string[] = []) =>
  smoltalk
    .assistantMessage(text, {
      toolCalls: callIds.map((id) => new smoltalk.ToolCall(id, "lookup", {})),
    })
    .toJSON();
const toolResult = (id: string) =>
  smoltalk.toolMessage("found", { tool_call_id: id, name: "lookup" }).toJSON();

/** What a seeded thread holds, as role, text, and the ids of its calls. */
function shape(messages: smoltalk.Message[]): unknown[] {
  return messages.map((message) => {
    const json = message.toJSON() as { toolCalls?: { id: string }[]; content?: unknown };
    return [message.role, json.content ?? "", (json.toolCalls ?? []).map((call) => call.id)];
  });
}

describe("seedFrom", () => {
  it("returns a list with no tool calls unchanged", () => {
    const seeded = seedFrom([user("hello"), assistant("hi")]);
    expect(shape(seeded)).toEqual([
      ["user", "hello", []],
      ["assistant", "hi", []],
    ]);
  });

  it("drops a dangling call and keeps the message's text", () => {
    const seeded = seedFrom([user("find it"), assistant("Looking.", ["c1"])]);
    expect(shape(seeded)).toEqual([
      ["user", "find it", []],
      ["assistant", "Looking.", []],
    ]);
  });

  it("removes a message that was only a dangling call", () => {
    const seeded = seedFrom([user("find it"), assistant("", ["c1"])]);
    expect(shape(seeded)).toEqual([["user", "find it", []]]);
  });

  it("drops both of two dangling calls", () => {
    const seeded = seedFrom([user("find it"), assistant("", ["c1", "c2"])]);
    expect(shape(seeded)).toEqual([["user", "find it", []]]);
  });

  it("keeps an answered call and its result when a sibling call dangles", () => {
    const seeded = seedFrom([user("find it"), assistant("", ["c1", "c2"]), toolResult("c1")]);
    expect(shape(seeded)).toEqual([
      ["user", "find it", []],
      ["assistant", "", ["c1"]],
      ["tool", "found", []],
    ]);
  });

  it("leaves an answered call earlier in the list alone", () => {
    const seeded = seedFrom([
      user("find it"),
      assistant("", ["c1"]),
      toolResult("c1"),
      assistant("Here it is."),
    ]);
    expect(seeded).toHaveLength(4);
    expect(shape(seeded)[1]).toEqual(["assistant", "", ["c1"]]);
  });

  it("throws on input that is not a list", () => {
    expect(() => seedFrom({ messages: [] })).toThrow("must be a JSON list");
  });
});

describe("seedFirstThread", () => {
  it("puts the seed on the store's first thread", () => {
    const threads = ThreadStore.withDefaultActive();
    seedFirstThread(threads, [user("hello"), assistant("", ["c1"])]);
    expect(shape(threads.getOrCreateActive().getMessages())).toEqual([["user", "hello", []]]);
  });
});
