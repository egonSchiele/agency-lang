import { describe, it, expect } from "vitest";
import { MemoryGraph } from "./graph.js";

describe("MemoryGraph", () => {
  it("starts empty", () => {
    const graph = new MemoryGraph();
    expect(graph.getEntities()).toEqual([]);
    expect(graph.getRelations()).toEqual([]);
  });

  it("adds an entity", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    expect(entity.name).toBe("Mom");
    expect(entity.type).toBe("person");
    expect(entity.source).toBe("gifting-agent");
    expect(entity.observations).toEqual([]);
    expect(graph.getEntities()).toHaveLength(1);
  });

  it("adds an observation to an entity", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    const obs = graph.addObservation(entity.id, "Likes pottery");
    expect(obs.content).toBe("Likes pottery");
    expect(obs.validFrom).toBeTruthy();
    expect(obs.validTo).toBeNull();
  });

  it("expires an observation", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    const obs = graph.addObservation(entity.id, "Favorite color is blue");
    graph.expireObservation(obs.id);
    const updated = graph.getEntity(entity.id);
    expect(updated!.observations[0].validTo).toBeTruthy();
  });

  it("adds a relation between entities", () => {
    const graph = new MemoryGraph();
    const user = graph.addEntity("User", "user", "system");
    const mom = graph.addEntity("Mom", "person", "gifting-agent");
    const rel = graph.addRelation(user.id, mom.id, "mother-of", "gifting-agent");
    expect(rel.from).toBe(user.id);
    expect(rel.to).toBe(mom.id);
    expect(rel.type).toBe("mother-of");
    expect(graph.getRelations()).toHaveLength(1);
  });

  it("finds entity by name (case-insensitive)", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "gifting-agent");
    expect(graph.findEntityByName("mom")).toBeTruthy();
    expect(graph.findEntityByName("Mom")).toBeTruthy();
    expect(graph.findEntityByName("Dad")).toBeNull();
  });

  it("gets current observations only", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    graph.addObservation(entity.id, "Favorite color is blue");
    graph.addObservation(entity.id, "Likes pottery");
    const obs = graph.getEntity(entity.id)!.observations[0];
    graph.expireObservation(obs.id);
    const current = graph.getCurrentObservations(entity.id);
    expect(current).toHaveLength(1);
    expect(current[0].content).toBe("Likes pottery");
  });

  it("serializes to and from JSON", () => {
    const graph = new MemoryGraph();
    const entity = graph.addEntity("Mom", "person", "gifting-agent");
    graph.addObservation(entity.id, "Likes pottery");
    const json = graph.toJSON();
    const restored = MemoryGraph.fromJSON(json);
    expect(restored.getEntities()).toHaveLength(1);
    expect(restored.getEntities()[0].observations).toHaveLength(1);
  });

  it("finds entities by type", () => {
    const graph = new MemoryGraph();
    graph.addEntity("Mom", "person", "gifting-agent");
    graph.addEntity("Dad", "person", "gifting-agent");
    graph.addEntity("Pottery", "category", "gifting-agent");
    const people = graph.findEntitiesByType("person");
    expect(people).toHaveLength(2);
  });

  it("finds relations by entity", () => {
    const graph = new MemoryGraph();
    const user = graph.addEntity("User", "user", "system");
    const mom = graph.addEntity("Mom", "person", "gifting-agent");
    const dad = graph.addEntity("Dad", "person", "gifting-agent");
    graph.addRelation(user.id, mom.id, "mother-of", "gifting-agent");
    graph.addRelation(user.id, dad.id, "father-of", "gifting-agent");
    const rels = graph.getRelationsFrom(user.id);
    expect(rels).toHaveLength(2);
  });

  it("expires a relation", () => {
    const graph = new MemoryGraph();
    const user = graph.addEntity("User", "user", "system");
    const mom = graph.addEntity("Mom", "person", "gifting-agent");
    const rel = graph.addRelation(user.id, mom.id, "likes", "gifting-agent");
    graph.expireRelation(rel.id);
    const updated = graph.getRelations()[0];
    expect(updated.validTo).toBeTruthy();
  });

  it("generates a compact index for LLM context", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "gifting-agent");
    graph.addObservation(mom.id, "Likes pottery");
    const index = graph.toCompactIndex();
    expect(index).toContain("Mom");
    expect(index).toContain("person");
  });
});
