import { describe, it, expect } from "vitest";
import {
  structuredLookup,
  formatRetrievalResults,
} from "./retrieval.js";
import { MemoryGraph } from "./graph.js";

describe("structuredLookup", () => {
  it("finds entities by name substring (keyword query)", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    graph.addEntity("Dad", "person", "test");
    const results = structuredLookup(graph, "mom");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("finds entities when the query mentions the name (descriptive query)", () => {
    // Regression for the user-reported recall failure: a long
    // natural-language query that contains an entity name should
    // hit Tier 1, not require an LLM rerank.
    const graph = new MemoryGraph();
    const maggie = graph.addEntity("Maggie", "Person", "test");
    graph.addObservation(maggie.id, "loves to weave");
    const results = structuredLookup(graph, "Tell me something about Maggie");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Maggie");
  });

  it("respects word boundaries (Bob does not match Bobby)", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Bob", "person", "test");
    const results = structuredLookup(graph, "Bobby went home");
    expect(results).toHaveLength(0);
  });

  it("skips entity names shorter than the minimum length", () => {
    // Short names like "AI" would otherwise match arbitrary
    // queries that happen to contain those two letters as a token.
    const graph = new MemoryGraph();
    graph.addEntity("AI", "topic", "test");
    const results = structuredLookup(graph, "the AI is here");
    expect(results).toHaveLength(0);
  });

  it("skips entity names that are stop words", () => {
    const graph = new MemoryGraph();
    graph.addEntity("the", "filler", "test");
    const results = structuredLookup(graph, "this is the answer");
    expect(results).toHaveLength(0);
  });

  it("finds entities by type", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    graph.addEntity("Pottery", "category", "test");
    const results = structuredLookup(graph, "person");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("finds entities by observation content (keyword)", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    const dad = graph.addEntity("Dad", "person", "test");
    graph.addObservation(dad.id, "Likes fishing");
    const results = structuredLookup(graph, "pottery");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("finds entities by observation content (descriptive query)", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    const results = structuredLookup(graph, "Who likes pottery the most?");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("returns empty for no matches", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    const results = structuredLookup(graph, "xyz123");
    expect(results).toHaveLength(0);
  });

  it("returns empty for empty queries", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    expect(structuredLookup(graph, "")).toHaveLength(0);
    expect(structuredLookup(graph, "   ")).toHaveLength(0);
  });

  it("filters by source when specified", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "gifting-agent");
    graph.addEntity("Mom", "person", "support-bot");
    const results = structuredLookup(graph, "mom", { source: "gifting-agent" });
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("gifting-agent");
  });
});

describe("formatRetrievalResults", () => {
  it("formats entities with observations as readable text", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    graph.addObservation(mom.id, "Birthday is March 5");
    const entities = [graph.getEntity(mom.id)!];
    const text = formatRetrievalResults(graph, entities);
    expect(text).toContain("Mom");
    expect(text).toContain("Likes pottery");
    expect(text).toContain("Birthday is March 5");
  });

  it("includes relations in formatted output", () => {
    const graph = new MemoryGraph();
    const user = graph.addEntity("User", "user", "test");
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addRelation(user.id, mom.id, "mother-of", "test");
    const entities = graph.getEntities();
    const text = formatRetrievalResults(graph, entities);
    expect(text).toContain("mother-of");
  });

  it("returns empty string for no results", () => {
    const graph = new MemoryGraph();
    const text = formatRetrievalResults(graph, []);
    expect(text).toBe("");
  });
});
