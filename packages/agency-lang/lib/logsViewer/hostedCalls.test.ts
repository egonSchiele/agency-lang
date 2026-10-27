import { describe, expect, it } from "vitest";
import { hostedCallShortLabel, hostedCallTitle, owningRowId } from "./hostedCalls.js";
import { event, hostedSearchEvents } from "./storyFixture.js";
import { roundsOf } from "./timeline/rounds.js";
import { buildForest } from "./tree.js";

function callsFor(hostedToolResults: unknown) {
  const forest = buildForest([
    event("promptCompletion", 100, "L", null, {
      completion: { output: "done", hostedToolResults },
    }),
  ]);
  return roundsOf(forest[0])[0].hostedCalls;
}

describe("hosted calls on a round", () => {
  it("reads one call per OpenAI web_search_call item, by what its action did", () => {
    const forest = buildForest(hostedSearchEvents());
    const calls = roundsOf(forest[0])[0].hostedCalls;
    expect(
      calls.map((call) => [call.id, call.tool, call.provider, call.gist, call.status]),
    ).toEqual([
      [
        "round:L:0:hosted:0",
        "web_search",
        "openai-responses",
        "agency language · agency docs",
        "completed",
      ],
      [
        "round:L:0:hosted:1",
        "web_search",
        "openai-responses",
        "open https://example.com/docs",
        "completed",
      ],
    ]);
    expect(calls[0].details).toEqual({ queries: ["agency language", "agency docs"] });
    expect(calls[1].details).toEqual({ url: "https://example.com/docs" });
    expect(calls[1].raw).toEqual([expect.objectContaining({ id: "ws_2" })]);
  });

  it("reads a find-in-page action and a failed status", () => {
    const [call] = callsFor([
      {
        tool: "web_search",
        provider: "openai-responses",
        raw: [
          {
            type: "web_search_call",
            status: "failed",
            action: { type: "find_in_page", url: "https://a.dev", pattern: "pricing" },
          },
        ],
      },
    ]);
    expect(call.gist).toBe('find "pricing" in https://a.dev');
    expect(call.failed).toBe(true);
    expect(hostedCallTitle(call)).toBe("✖ HOSTED TOOL CALL · web_search");
    expect(hostedCallShortLabel(call)).toBe("✖ hosted · web_search");
  });

  it("pairs an Anthropic server_tool_use with the result that names it", () => {
    const calls = callsFor([
      {
        tool: "web_search",
        provider: "anthropic",
        raw: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "tarsec" } },
          { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "smoltalk" } },
          {
            type: "web_search_tool_result",
            tool_use_id: "s1",
            content: [{ type: "web_search_result", title: "Tarsec", url: "https://t.dev" }],
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "s2",
            content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
          },
        ],
      },
    ]);
    expect(calls.map((call) => [call.gist, call.status, call.failed])).toEqual([
      ["tarsec", "completed", false],
      ["smoltalk", "failed", true],
    ]);
    expect(calls[0].details).toEqual({
      query: "tarsec",
      sources: [{ title: "Tarsec", url: "https://t.dev" }],
    });
    expect(calls[1].details).toEqual({ query: "smoltalk", error: "max_uses_exceeded" });
    expect(calls[0].raw).toHaveLength(2);
  });

  it("reads an object result with no error_code as a success", () => {
    const [call] = callsFor([
      {
        tool: "web_fetch",
        provider: "anthropic",
        raw: [
          { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://a.dev" } },
          {
            type: "web_fetch_tool_result",
            tool_use_id: "f1",
            content: { type: "web_fetch_result", url: "https://a.dev", content: {} },
          },
        ],
      },
    ]);
    expect([call.gist, call.status, call.failed]).toEqual(["https://a.dev", "completed", false]);
  });

  it("pairs a call with no id with no result", () => {
    const [call] = callsFor([
      {
        tool: "web_search",
        provider: "anthropic",
        raw: [
          { type: "server_tool_use", name: "web_search", input: { query: "q" } },
          { type: "text", content: { error_code: "unrelated" } },
        ],
      },
    ]);
    expect([call.status, call.failed, call.raw]).toEqual([
      undefined,
      false,
      [expect.objectContaining({ type: "server_tool_use" })],
    ]);
  });

  it("falls back to the recorded queries, keeping the sources and raw record", () => {
    const grounding = { webSearchQueries: ["a", "b"] };
    const calls = callsFor([
      {
        tool: "web_search",
        provider: "google",
        queries: ["a", "b"],
        sources: [{ url: "https://s.dev" }],
        raw: grounding,
      },
    ]);
    expect(calls.map((call) => [call.gist, call.status])).toEqual([
      ["a", undefined],
      ["b", undefined],
    ]);
    expect(calls[0].details).toEqual({ query: "a", sources: [{ url: "https://s.dev" }] });
    expect(calls[0].raw).toEqual([grounding]);
  });

  it("finds the round a hosted call ran in from its id", () => {
    expect(owningRowId("round:L:0:hosted:1")).toBe("round:L:0");
    expect(owningRowId("round:L:0")).toBe("round:L:0");
    expect(owningRowId("read")).toBe("read");
  });

  it("makes one call for a result that recorded only its sources", () => {
    const calls = callsFor([
      { tool: "web_search", provider: "openrouter", citations: [{ url: "https://c.dev" }] },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].details).toEqual({ sources: [{ url: "https://c.dev" }] });
  });

  it("finds nothing on a call without hosted results, or with malformed ones", () => {
    expect(callsFor(undefined)).toEqual([]);
    expect(callsFor("not a list")).toEqual([]);
    expect(callsFor([null, 3, { provider: "no tool name" }])).toEqual([]);
  });
});
