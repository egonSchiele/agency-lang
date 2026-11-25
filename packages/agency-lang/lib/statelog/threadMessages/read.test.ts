import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "../wireTypes.js";
import { rebuildAllMessages, rebuildMessages, type RebuildState } from "./read.js";
import { reply, user, writtenEvents as written } from "./testFixtures.js";

function inOrder(events: EventEnvelope[]): EventEnvelope[] {
  const state: RebuildState = {};
  return events.map((event) => rebuildMessages(state, event));
}

const listsOf = (events: EventEnvelope[]) => events.map((event) => event.data.messages);

describe("rebuildMessages", () => {
  it("rebuilds every call of a growing thread", () => {
    const lists = [
      [user("1")],
      [user("1"), reply("r1"), user("2")],
      [user("1"), reply("r1"), user("2"), reply("r2"), user("3")],
    ];
    expect(listsOf(inOrder(written(lists)))).toEqual(lists);
  });

  it("rebuilds across a rewritten history", () => {
    const lists = [
      [user("a"), reply("b"), user("c"), reply("d")],
      [user("a"), user("s"), reply("d")],
      [user("a"), user("s"), reply("d"), user("e")],
    ];
    expect(listsOf(inOrder(written(lists)))).toEqual(lists);
  });

  it("rebuilds two branches that grow apart on one thread", () => {
    const base = user("base");
    const lists = [
      [base],
      [base, reply("a1")],
      [base, reply("b1")],
      [base, reply("a1"), reply("a2")],
      [base, reply("b1"), reply("b2")],
    ];
    expect(listsOf(inOrder(written(lists)))).toEqual(lists);
  });

  it("rebuilds two writers whose events interleave in one trace", () => {
    const parentLists = [[user("p1")], [user("p1"), user("p2")]];
    const childLists = [[user("c1")], [user("c1"), user("c2")]];
    const parent = written(parentLists, { writer: "p" });
    const child = written(childLists, { writer: "c" });
    const rebuilt = inOrder([parent[0], child[0], parent[1], child[1]]);
    expect(listsOf(rebuilt)).toEqual([
      parentLists[0],
      childLists[0],
      parentLists[1],
      childLists[1],
    ]);
  });

  it("marks a lost call and every change after it until the next full copy", () => {
    const events = written([
      [user("1")],
      [user("1"), user("2")],
      [user("1"), user("2"), user("3")],
      [user("1"), user("2"), user("3"), user("4")],
    ]);
    const [, third, fourth] = inOrder([events[0], events[2], events[3]]);
    expect(third.data.missingMessages).toBe(events[2].data.keptMessages);
    expect(third.data.messages).toEqual(events[2].data.newMessages);
    expect(fourth.data.missingMessages).toBe(events[3].data.keptMessages);
    expect(fourth.data.messages).toEqual(events[3].data.newMessages);
    expect(third.data.newMessages).toBeUndefined();
    expect(fourth.data.newMessages).toBeUndefined();
  });

  it("leaves a malformed change as it is and marks the next change on its thread", () => {
    const events = written([
      [user("1")],
      [user("1"), user("2")],
      [user("1"), user("2"), user("3")],
    ]);
    const malformed = { ...events[1], data: { ...events[1].data, keptMessages: "1" } };
    const [, second, third] = inOrder([events[0], malformed, events[2]]);
    expect(second).toBe(malformed);
    expect(third.data.missingMessages).toBe(events[2].data.keptMessages);
  });

  it("leaves events without writer fields untouched", () => {
    const old: EventEnvelope = {
      format_version: 1,
      trace_id: "t",
      project_id: "",
      span_id: null,
      parent_span_id: null,
      data: { type: "promptCompletion", timestamp: "", messages: [user("1")] },
    };
    const tool: EventEnvelope = { ...old, data: { type: "toolCall", timestamp: "" } };
    const state: RebuildState = {};
    expect(rebuildMessages(state, old)).toBe(old);
    expect(rebuildMessages(state, tool)).toBe(tool);
  });

  it("does not change the events it is given", () => {
    const events = written([[user("1")], [user("1"), user("2")]]);
    const before = structuredClone(events);
    inOrder(events);
    expect(events).toEqual(before);
  });
});

describe("rebuildAllMessages", () => {
  it("rebuilds a batch that arrived out of order", () => {
    const lists = [[user("1")], [user("1"), user("2")], [user("1"), user("2"), user("3")]];
    const [first, second, third] = written(lists);
    const rebuilt = rebuildAllMessages([third, first, second]);
    expect(listsOf(rebuilt)).toEqual([lists[2], lists[0], lists[1]]);
  });

  it("changes nothing when run a second time, gaps included", () => {
    const events = written([
      [user("1")],
      [user("1"), user("2")],
      [user("1"), user("2"), user("3")],
      [user("1"), user("2"), user("3"), user("4")],
    ]);
    const withGap = [events[0], events[2], events[3]];
    const once = rebuildAllMessages(withGap);
    expect(rebuildAllMessages(once)).toEqual(once);
    expect(once[2].data.missingMessages).toBeDefined();
  });
});
