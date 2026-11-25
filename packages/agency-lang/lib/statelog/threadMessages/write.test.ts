import { describe, expect, it } from "vitest";
import { FULL_COPY_EVERY_CALLS, messageFieldsFor, type LoggedThread } from "./write.js";

const user = (content: string) => ({ role: "user", content });
const reply = (content: string) => ({ role: "assistant", content });

describe("messageFieldsFor", () => {
  it("logs a thread's first call whole", () => {
    const { fields, logged } = messageFieldsFor({
      previous: undefined,
      logWriter: "w",
      messages: [user("one")],
    });
    expect(fields).toEqual({ messages: [user("one")], logWriter: "w", threadCall: 1 });
    expect(logged.call).toBe(1);
  });

  it("logs only what a grown thread added", () => {
    const first = messageFieldsFor({
      previous: undefined,
      logWriter: "w",
      messages: [user("one")],
    });
    const { fields } = messageFieldsFor({
      previous: first.logged,
      logWriter: "w",
      messages: [user("one"), reply("r1"), user("two")],
    });
    expect(fields).toEqual({
      keptMessages: 1,
      newMessages: [reply("r1"), user("two")],
      logWriter: "w",
      threadCall: 2,
    });
  });

  it("keeps only the unchanged start of a rewritten history", () => {
    const before = messageFieldsFor({
      previous: undefined,
      logWriter: "w",
      messages: [user("a"), reply("b"), user("c"), reply("d")],
    });
    const { fields } = messageFieldsFor({
      previous: before.logged,
      logWriter: "w",
      messages: [user("a"), user("summary"), reply("d")],
    });
    expect(fields).toEqual({
      keptMessages: 1,
      newMessages: [user("summary"), reply("d")],
      logWriter: "w",
      threadCall: 2,
    });
  });

  it("logs a full copy when nothing at the start is unchanged", () => {
    const before = messageFieldsFor({ previous: undefined, logWriter: "w", messages: [user("a")] });
    const { fields } = messageFieldsFor({
      previous: before.logged,
      logWriter: "w",
      messages: [user("z")],
    });
    expect(fields).toEqual({ messages: [user("z")], logWriter: "w", threadCall: 2 });
  });

  it("logs a full copy again on call FULL_COPY_EVERY_CALLS + 1", () => {
    let previous: LoggedThread | undefined;
    const messages: unknown[] = [];
    const shapes: string[] = [];
    for (let call = 1; call <= FULL_COPY_EVERY_CALLS + 1; call++) {
      messages.push(user(`m${call}`));
      const result = messageFieldsFor({ previous, logWriter: "w", messages: [...messages] });
      shapes.push("messages" in result.fields ? "full" : "change");
      previous = result.logged;
    }
    expect(shapes[0]).toBe("full");
    expect(shapes[1]).toBe("change");
    expect(shapes[FULL_COPY_EVERY_CALLS - 1]).toBe("change");
    expect(shapes[FULL_COPY_EVERY_CALLS]).toBe("full");
  });

  it("logs an empty change when the thread did not change", () => {
    const first = messageFieldsFor({
      previous: undefined,
      logWriter: "w",
      messages: [user("one")],
    });
    const { fields } = messageFieldsFor({
      previous: first.logged,
      logWriter: "w",
      messages: [user("one")],
    });
    expect(fields).toEqual({ keptMessages: 1, newMessages: [], logWriter: "w", threadCall: 2 });
  });

  it("keeps a message whose keys came back in a different order", () => {
    const first = messageFieldsFor({
      previous: undefined,
      logWriter: "w",
      messages: [{ role: "assistant", content: "r1", usage: { inputTokens: 1, outputTokens: 2 } }],
    });
    const { fields } = messageFieldsFor({
      previous: first.logged,
      logWriter: "w",
      messages: [
        { usage: { outputTokens: 2, inputTokens: 1 }, content: "r1", role: "assistant" },
        user("two"),
      ],
    });
    expect(fields).toEqual({
      keptMessages: 1,
      newMessages: [user("two")],
      logWriter: "w",
      threadCall: 2,
    });
  });
});
