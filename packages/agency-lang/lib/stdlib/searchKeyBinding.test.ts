/**
 * The web-search tools must never show an `apiKey` parameter to a model.
 *
 * `stdlib/agents/lib/search.agency` binds the key with `.partial()` before
 * handing each tool to an agent. Before it did, a run had the model fill the
 * slot with its own tool-call markup — `"</antml_parameter>\n<parameter
 * name=\"searchDepth\">basic"` — which reached the HTTP layer as an
 * Authorization header and failed every search in the run. The tool's own
 * env-var fallback did not save it: that only applies when `apiKey` arrives
 * empty, and a hallucinated key is not empty.
 *
 * These assertions cover the mechanism (binding removes the parameter, and a
 * later `.rename()` keeps the agent-facing name). They do not prove the
 * stdlib wiring calls it — that path needs the Agency runtime.
 */
import { describe, expect, it } from "vitest";
import { search as braveSearch, tavilySearch } from "../../stdlib/web/search.js";

function paramNames(fn: { toolDefinition: { schema: { toJSONSchema: () => unknown } } }): string[] {
  const schema = fn.toolDefinition.schema.toJSONSchema() as {
    properties?: Record<string, unknown>;
  };
  return Object.keys(schema.properties ?? {});
}

describe("web-search tools", () => {
  it("expose apiKey when unbound, which is why binding is required", () => {
    expect(paramNames(tavilySearch as never)).toContain("apiKey");
    expect(paramNames(braveSearch as never)).toContain("apiKey");
  });

  it("drop apiKey from the schema once it is bound", () => {
    const tavily = (tavilySearch as never as { partial: (a: object) => never }).partial({
      apiKey: "test-key",
    });
    const brave = (braveSearch as never as { partial: (a: object) => never }).partial({
      apiKey: "test-key",
    });
    expect(paramNames(tavily)).not.toContain("apiKey");
    expect(paramNames(brave)).not.toContain("apiKey");
  });

  it("keep the parameters the model actually needs", () => {
    const tavily = (tavilySearch as never as { partial: (a: object) => never }).partial({
      apiKey: "test-key",
    });
    expect(paramNames(tavily)).toEqual(["query", "count", "searchDepth", "topic"]);
  });

  it("still take the agent-facing name when renamed after binding", () => {
    // Order matters: `.partial()` keeps the base name, so `.rename()` has to
    // come last or every derived search tool collides on `tavilySearch`.
    const bound = (
      tavilySearch as never as {
        partial: (a: object) => { rename: (n: string) => never };
      }
    )
      .partial({ apiKey: "test-key" })
      .rename("web_search_tavily");
    expect((bound as never as { toolDefinition: { name: string } }).toolDefinition.name).toBe(
      "web_search_tavily",
    );
    expect(paramNames(bound)).not.toContain("apiKey");
  });
});
