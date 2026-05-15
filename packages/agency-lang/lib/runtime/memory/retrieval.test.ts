import { describe, it, expect } from "vitest";
import {
  structuredLookup,
  formatRetrievalResults,
  buildRetrievalPrompt,
} from "./retrieval.js";
import { MemoryGraph } from "./graph.js";

describe("structuredLookup", () => {
  it("finds entities by name substring", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    graph.addEntity("Dad", "person", "test");
    const results = structuredLookup(graph, "mom");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("finds entities by type", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    graph.addEntity("Pottery", "category", "test");
    const results = structuredLookup(graph, "person");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("finds entities by observation content", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    const dad = graph.addEntity("Dad", "person", "test");
    graph.addObservation(dad.id, "Likes fishing");
    const results = structuredLookup(graph, "pottery");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("Mom");
  });

  it("returns empty for no matches", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    const results = structuredLookup(graph, "xyz123");
    expect(results).toHaveLength(0);
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

describe("buildRetrievalPrompt", () => {
  it("includes the query and graph index", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Likes pottery");
    const prompt = buildRetrievalPrompt("what does mom like?", graph);
    expect(prompt).toContain("what does mom like?");
    expect(prompt).toContain("Mom");
  });
});
