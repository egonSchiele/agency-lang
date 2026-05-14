import { describe, it, expect } from "vitest";
import { cosineSimilarity, EmbeddingManager } from "./embeddings.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("handles high-dimensional vectors", () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 0.1));
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThanOrEqual(1.0);
  });
});

describe("EmbeddingManager", () => {
  it("finds top-k similar entries", () => {
    const manager = new EmbeddingManager();
    manager.setEntries([
      { id: "obs-1", vector: [1, 0, 0] },
      { id: "obs-2", vector: [0, 1, 0] },
      { id: "obs-3", vector: [0.9, 0.1, 0] },
    ]);
    const results = manager.findSimilar([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("obs-1");
    expect(results[1].id).toBe("obs-3");
  });

  it("filters by minimum threshold", () => {
    const manager = new EmbeddingManager();
    manager.setEntries([
      { id: "obs-1", vector: [1, 0, 0] },
      { id: "obs-2", vector: [0, 1, 0] },
    ]);
    const results = manager.findSimilar([1, 0, 0], 10, 0.5);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("obs-1");
  });

  it("serializes to and from EmbeddingIndex", () => {
    const manager = new EmbeddingManager();
    manager.setModel("test-model");
    manager.setEntries([{ id: "obs-1", vector: [1, 2, 3] }]);
    const index = manager.toIndex();
    expect(index.model).toBe("test-model");
    expect(index.entries).toHaveLength(1);

    const restored = EmbeddingManager.fromIndex(index);
    expect(restored.findSimilar([1, 2, 3], 1)[0].id).toBe("obs-1");
  });
});
