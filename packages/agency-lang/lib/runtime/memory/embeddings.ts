import { DEFAULT_EMBEDDING_MODEL } from "../../constants.js";
import type { EmbeddingEntry, EmbeddingIndex } from "./types.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

export type SimilarityResult = {
  id: string;
  score: number;
};

export class EmbeddingManager {
  private entries: EmbeddingEntry[] = [];
  private model = DEFAULT_EMBEDDING_MODEL;

  setModel(model: string): void {
    this.model = model;
  }

  getModel(): string {
    return this.model;
  }

  setEntries(entries: EmbeddingEntry[]): void {
    this.entries = entries;
  }

  addEntry(id: string, vector: number[]): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.entries.push({ id, vector });
  }

  removeEntry(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  findSimilar(
    queryVector: number[],
    topK: number,
    minThreshold = 0.0
  ): SimilarityResult[] {
    const scored = this.entries
      .map((entry) => ({
        id: entry.id,
        score: cosineSimilarity(queryVector, entry.vector),
      }))
      .filter((r) => r.score >= minThreshold);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  toIndex(): EmbeddingIndex {
    return { model: this.model, entries: this.entries };
  }

  static fromIndex(index: EmbeddingIndex): EmbeddingManager {
    const manager = new EmbeddingManager();
    manager.model = index.model;
    manager.entries = index.entries;
    return manager;
  }
}
