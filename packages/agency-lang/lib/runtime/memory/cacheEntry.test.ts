import { describe, it, expect, vi } from "vitest";
import { MemoryCacheEntry } from "./cacheEntry.js";
import { MemoryGraph } from "./graph.js";
import { EmbeddingManager } from "./embeddings.js";
import type {
  ConversationSummary,
  EmbeddingIndex,
  MemoryGraphData,
  MemoryStore,
} from "./types.js";

// Tiny in-memory MemoryStore stub. Records the most recent save for
// each method so tests can assert that persist() routes to the right
// memoryId.
function inMemoryStore(): MemoryStore & {
  graphSaves: Array<{ id: string; graph: MemoryGraphData }>;
  embeddingSaves: Array<{ id: string; index: EmbeddingIndex }>;
  summarySaves: Array<{ id: string; summary: ConversationSummary }>;
} {
  const graphSaves: Array<{ id: string; graph: MemoryGraphData }> = [];
  const embeddingSaves: Array<{ id: string; index: EmbeddingIndex }> = [];
  const summarySaves: Array<{ id: string; summary: ConversationSummary }> = [];
  return {
    graphSaves,
    embeddingSaves,
    summarySaves,
    loadGraph: async () => ({ entities: [], relations: [], nextId: 1 }),
    saveGraph: async (id, graph) => {
      graphSaves.push({ id, graph });
    },
    loadEmbeddings: async () => null,
    saveEmbeddings: async (id, index) => {
      embeddingSaves.push({ id, index });
    },
    loadSummary: async () => null,
    saveSummary: async (id, summary) => {
      summarySaves.push({ id, summary });
    },
  };
}

describe("MemoryCacheEntry", () => {
  it("seeds the obs->entity index from the loaded graph", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    const obs = graph.addObservation(mom.id, "Likes pottery");
    const entry = new MemoryCacheEntry(
      "default",
      graph,
      new EmbeddingManager(),
      null,
    );
    expect(entry.lookupEntityIdByObs(obs.id)).toBe(mom.id);
  });

  it("applyExtraction adds new observations and updates the reverse index", () => {
    const graph = new MemoryGraph();
    const embeddings = new EmbeddingManager();
    const entry = new MemoryCacheEntry("default", graph, embeddings, null);
    const outcome = entry.applyExtraction(
      {
        entities: [
          { name: "Mom", type: "person", observations: ["Likes pottery"] },
        ],
        relations: [],
        expirations: [],
      },
      "test",
    );
    expect(outcome.newObservationIds).toHaveLength(1);
    expect(outcome.expiredObservationIds).toHaveLength(0);
    const newObsId = outcome.newObservationIds[0];
    const mom = graph.findEntityByName("Mom")!;
    // Reverse index now includes the freshly-added observation.
    expect(entry.lookupEntityIdByObs(newObsId)).toBe(mom.id);
  });

  it("applyExtraction drops embedding entries for expired observations", () => {
    // Seed: one entity with one observation + a stored embedding.
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    const obs = graph.addObservation(mom.id, "Likes pottery");
    const embeddings = new EmbeddingManager();
    embeddings.addEntry(obs.id, [1, 0, 0]);
    const entry = new MemoryCacheEntry("default", graph, embeddings, null);

    // Expire it via an extraction result that contains the same obs
    // text under the same entity name.
    const outcome = entry.applyExtraction(
      {
        entities: [],
        relations: [],
        expirations: [
          { entityName: "Mom", observationContent: "Likes pottery" },
        ],
      },
      "test",
    );
    expect(outcome.expiredObservationIds).toEqual([obs.id]);
    // Embedding entry for the expired obs should be gone — querying
    // findSimilar against its exact vector returns nothing.
    expect(embeddings.findSimilar([1, 0, 0], 5)).toEqual([]);
  });

  it("expireObservation removes the embedding in lockstep with the graph mutation", () => {
    const graph = new MemoryGraph();
    const mom = graph.addEntity("Mom", "person", "test");
    const obs = graph.addObservation(mom.id, "Likes pottery");
    const embeddings = new EmbeddingManager();
    embeddings.addEntry(obs.id, [1, 0, 0]);
    const entry = new MemoryCacheEntry("default", graph, embeddings, null);

    entry.expireObservation(obs.id);
    expect(graph.getCurrentObservations(mom.id)).toHaveLength(0);
    expect(embeddings.findSimilar([1, 0, 0], 5)).toEqual([]);
  });

  it("expireRelation expires the relation on the graph", () => {
    const graph = new MemoryGraph();
    const a = graph.addEntity("A", "person", "test");
    const b = graph.addEntity("B", "person", "test");
    const rel = graph.addRelation(a.id, b.id, "knows", "test");
    const entry = new MemoryCacheEntry(
      "default",
      graph,
      new EmbeddingManager(),
      null,
    );
    entry.expireRelation(rel.id);
    const stillActive = graph.getRelations().some((r) => r.id === rel.id && r.validTo === null);
    expect(stillActive).toBe(false);
  });

  it("setEmbedding stashes a vector that findSimilar can recover", () => {
    const embeddings = new EmbeddingManager();
    const entry = new MemoryCacheEntry(
      "default",
      new MemoryGraph(),
      embeddings,
      null,
    );
    entry.setEmbedding("obs-1", [0.5, 0.5, 0.5]);
    const hit = embeddings.findSimilar([0.5, 0.5, 0.5], 1);
    expect(hit).toHaveLength(1);
    expect(hit[0].id).toBe("obs-1");
  });

  it("persist routes saves to the captured memoryId, ignoring later getMemoryId changes", async () => {
    const store = inMemoryStore();
    const entry = new MemoryCacheEntry(
      "user-a",
      new MemoryGraph(),
      new EmbeddingManager(),
      { summary: "s", lastCompactedAt: "2026-05-16", messagesSummarized: 2 },
    );
    await entry.persist(store);
    expect(store.graphSaves.map((s) => s.id)).toEqual(["user-a"]);
    expect(store.embeddingSaves.map((s) => s.id)).toEqual(["user-a"]);
    expect(store.summarySaves.map((s) => s.id)).toEqual(["user-a"]);
  });

  it("persist skips saveSummary when no summary is set", async () => {
    const store = inMemoryStore();
    const entry = new MemoryCacheEntry(
      "default",
      new MemoryGraph(),
      new EmbeddingManager(),
      null,
    );
    await entry.persist(store);
    expect(store.graphSaves).toHaveLength(1);
    expect(store.embeddingSaves).toHaveLength(1);
    expect(store.summarySaves).toHaveLength(0);
  });

  it("setSummary / getSummary round-trip", () => {
    const entry = new MemoryCacheEntry(
      "default",
      new MemoryGraph(),
      new EmbeddingManager(),
      null,
    );
    expect(entry.getSummary()).toBeNull();
    const s: ConversationSummary = {
      summary: "hi",
      lastCompactedAt: "2026-05-16",
      messagesSummarized: 3,
    };
    entry.setSummary(s);
    expect(entry.getSummary()).toEqual(s);
  });
});
