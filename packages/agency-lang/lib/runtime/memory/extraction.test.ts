import { describe, it, expect } from "vitest";
import { buildExtractionPrompt, applyExtractionResult } from "./extraction.js";
import { MemoryGraph } from "./graph.js";

describe("buildExtractionPrompt", () => {
  it("includes conversation messages in the prompt", () => {
    const messages = [
      { role: "user" as const, content: "My mom loves pottery" },
      { role: "assistant" as const, content: "That's great!" },
    ];
    const graph = new MemoryGraph();
    const prompt = buildExtractionPrompt(messages, graph);
    expect(prompt).toContain("My mom loves pottery");
  });

  it("includes existing entities for deduplication context", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    const prompt = buildExtractionPrompt([], graph);
    expect(prompt).toContain("Mom");
    expect(prompt).toContain("person");
  });
});

describe("applyExtractionResult", () => {
  it("adds new entities from extraction", () => {
    const graph = new MemoryGraph();
    const result = {
      entities: [
        { name: "Mom", type: "person", observations: ["Likes pottery"] },
      ],
      relations: [],
      expirations: [],
    };
    applyExtractionResult(graph, result, "test-agent");
    expect(graph.getEntities()).toHaveLength(1);
    expect(graph.getEntities()[0].observations).toHaveLength(1);
  });

  it("merges observations into existing entity by name", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "test");
    graph.addObservation(
      graph.findEntityByName("Mom")!.id,
      "Birthday is March 5"
    );
    const result = {
      entities: [
        { name: "Mom", type: "person", observations: ["Likes pottery"] },
      ],
      relations: [],
      expirations: [],
    };
    applyExtractionResult(graph, result, "test-agent");
    expect(graph.getEntities()).toHaveLength(1);
    expect(graph.getEntities()[0].observations).toHaveLength(2);
  });

  it("adds relations from extraction", () => {
    const graph = new MemoryGraph();
    graph.addEntity("User", "user", "test");
    graph.addEntity("Mom", "person", "test");
    const result = {
      entities: [],
      relations: [{ from: "User", to: "Mom", type: "mother-of" }],
      expirations: [],
    };
    applyExtractionResult(graph, result, "test-agent");
    expect(graph.getRelations()).toHaveLength(1);
  });

  it("expires old observations on contradiction", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    graph.addObservation(mom.id, "Favorite color is blue");
    const result = {
      entities: [
        { name: "Mom", type: "person", observations: ["Favorite color is red"] },
      ],
      relations: [],
      expirations: [
        { entityName: "Mom", observationContent: "Favorite color is blue" },
      ],
    };
    applyExtractionResult(graph, result, "test-agent");
    const current = graph.getCurrentObservations(mom.id);
    expect(current).toHaveLength(1);
    expect(current[0].content).toBe("Favorite color is red");
  });
});
