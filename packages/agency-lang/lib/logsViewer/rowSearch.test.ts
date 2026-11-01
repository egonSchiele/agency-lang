import { describe, expect, it } from "vitest";

import { findRow } from "./detailTarget.js";
import {
  matcherFor,
  searchTrace,
  snippetAround,
  type Matcher,
  type SearchKind,
} from "./rowSearch.js";
import { event, sampleRunForest } from "./storyFixture.js";
import { buildForest } from "./tree.js";
import type { EventEnvelope, TreeNode } from "./types.js";

const system = { role: "system", content: "You are a careful agent. Watchword: heliotrope." };
const user = { role: "user", content: "please read the zebra notes" };
const LONG_RESULT = `${"x".repeat(700)} needle at the end`;

/** Five LLM calls on one thread, each asking for one `read`. Every call's
 *  input carries the whole conversation so far, as a real log does. */
function fiveCalls(extra: EventEnvelope[] = []): TreeNode {
  const events: EventEnvelope[] = [
    event("enterNode", 50, "N", null, { nodeId: "main", data: { scratch: "stateonlyword" } }),
  ];
  let history: unknown[] = [system, user];
  for (let call = 0; call < 5; call++) {
    const at = 100 + call * 100;
    const request = { id: `c${call}`, name: "read", arguments: { filename: `file${call}.txt` } };
    const output = call === 0 ? LONG_RESULT : `contents of file ${call}`;
    events.push(
      event("promptCompletion", at, "L", null, {
        threadIdentity: "main",
        messages: history,
        completion: { output: `step ${call}`, toolCalls: [request] },
      }),
      event("toolCallStart", at + 1, `tool${call}`, "L", {
        toolName: "read",
        args: { filename: `file${call}.txt` },
      }),
      event("toolCall", at + 5, `tool${call}`, "L", { toolName: "read", output, timeTaken: 4 }),
    );
    history = [
      ...history,
      { role: "assistant", content: `step ${call}`, toolCalls: [request] },
      { role: "tool", name: "read", tool_call_id: `c${call}`, content: output },
    ];
  }
  return buildForest([...events, ...extra])[0];
}

function plain(pattern: string): Matcher {
  const matcher = matcherFor(pattern, { regex: false, caseSensitive: false });
  if ("error" in matcher) {
    throw new Error(matcher.error);
  }
  return matcher;
}

function search(trace: TreeNode, pattern: string, kinds?: SearchKind[]) {
  return searchTrace(trace, plain(pattern), { context: 20, kinds });
}

describe("searchTrace", () => {
  it("finds a word from the first user message once, on the user row", () => {
    expect(search(fiveCalls(), "zebra")).toEqual([
      expect.objectContaining({ rowId: "round:L:0:user", kind: "user", matches: 1 }),
    ]);
  });

  it("finds a word in a tool result on the tool row, even past 600 characters", () => {
    expect(search(fiveCalls(), "needle")).toEqual([
      expect.objectContaining({ rowId: "tool0", kind: "tool", matches: 1 }),
    ]);
  });

  it("finds a word in the system prompt on the first call of the thread only", () => {
    const hits = search(fiveCalls(), "heliotrope");
    expect(hits).toEqual([expect.objectContaining({ rowId: "round:L:0", kind: "call" })]);
    expect(findRow(fiveCalls(), hits[0].rowId)).toBeDefined();
  });

  it("finds nothing in node state", () => {
    expect(search(fiveCalls(), "stateonlyword")).toEqual([]);
  });

  it("finds a tool argument twice: on the call that asked and on the tool that ran", () => {
    expect(search(fiveCalls(), "file2.txt").map((hit) => hit.rowId)).toEqual([
      "round:L:2",
      "tool2",
    ]);
  });

  it("does not find an interrupt raised outside a tool call", () => {
    const interrupt = event("interruptResolved", 60, "N", null, {
      interruptId: "env",
      outcome: "approved",
      interrupt: { effect: "std::env", message: "read toplevelvariable?" },
    });
    expect(search(fiveCalls([interrupt]), "toplevelvariable")).toEqual([]);
  });

  it("finds an error raised inside a tool on the tool row", () => {
    const failure = event("error", 103, "tool0", "L", { message: "disk unplugged" });
    expect(search(fiveCalls([failure]), "unplugged")).toEqual([
      expect.objectContaining({ rowId: "tool0", kind: "tool" }),
    ]);
  });

  it("after a compaction, finds the new summary on the call that carried it", () => {
    const go = { role: "user", content: "continue" };
    const trace = buildForest([
      event("promptCompletion", 100, "L", null, {
        threadIdentity: "main",
        messages: [system, user, go],
        completion: { output: "first" },
      }),
      event("memoryCompaction", 150, "L"),
      event("promptCompletion", 200, "L", null, {
        threadIdentity: "main",
        messages: [system, { role: "system", content: "summary of the zebra work" }, go],
        completion: { output: "second" },
      }),
    ])[0];
    expect(search(trace, "summary of").map((hit) => hit.rowId)).toEqual(["round:L:1"]);
    expect(search(trace, "zebra").map((hit) => hit.rowId)).toEqual(["round:L:0:user", "round:L:1"]);
  });

  it("names only rows findRow resolves, across a recorded run", () => {
    const trace = sampleRunForest()[0];
    const hits = search(trace, "e");
    expect(hits.length).toBeGreaterThan(5);
    expect(hits.filter((hit) => findRow(trace, hit.rowId) === undefined)).toEqual([]);
  });

  it("filters by kind", () => {
    expect(search(fiveCalls(), "file2.txt", ["tool"]).map((hit) => hit.rowId)).toEqual(["tool2"]);
    expect(search(fiveCalls(), "zebra", ["tool", "call"])).toEqual([]);
  });

  it("counts every match in a row and gives each hit its header", () => {
    const hits = search(fiveCalls(), "xxxxxxxxxx");
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit).toMatchObject({ rowId: "tool0", matches: 70 });
    expect(hit.header).toMatch(/^Tool · read/);
  });
});

describe("matcherFor", () => {
  it("ignores case by default and matches case with caseSensitive", () => {
    expect(plain("ZEBRA").test("a zebra")).toEqual({ count: 1, first: 2, length: 5 });
    const exact = matcherFor("ZEBRA", { regex: false, caseSensitive: true });
    expect("error" in exact ? exact.error : exact.test("a zebra")).toBeUndefined();
  });

  it("treats a plain pattern literally and a regex as a regex", () => {
    expect(plain("a.c").test("abc")).toBeUndefined();
    const regex = matcherFor("a.c", { regex: true, caseSensitive: false });
    expect("error" in regex ? regex.error : regex.test("abc")).toEqual({
      count: 1,
      first: 0,
      length: 3,
    });
  });

  it("refuses an invalid regex with the parser's message, and an empty pattern", () => {
    const broken = matcherFor("(unclosed", { regex: true, caseSensitive: false });
    expect(broken).toEqual({ error: expect.stringContaining("Invalid regular expression") });
    expect(matcherFor("", { regex: false, caseSensitive: false })).toEqual({
      error: "the pattern is empty",
    });
  });
});

describe("snippetAround", () => {
  it("collapses whitespace and marks the cut ends", () => {
    const text = "first line\n\n  second line holds the word here\nthird line";
    const at = text.indexOf("word");
    expect(snippetAround(text, at, 4, 10)).toBe("…holds the word here thir…");
  });

  it("widens with the context and leaves short text whole", () => {
    expect(snippetAround("a word b", 2, 4, 60)).toBe("a word b");
    const text = "0123456789".repeat(10);
    expect(snippetAround(text, 50, 1, 5).length).toBeLessThan(
      snippetAround(text, 50, 1, 20).length,
    );
  });

  it("cuts a match longer than twice the context", () => {
    const text = "y".repeat(500);
    expect(snippetAround(text, 0, 500, 10)).toBe(`${"y".repeat(20)}…`);
  });
});
