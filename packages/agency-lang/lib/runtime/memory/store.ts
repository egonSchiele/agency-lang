import type {
  MemoryGraphData,
  ConversationSummary,
  EmbeddingIndex,
  MemoryStore,
} from "./types.js";
import fs from "node:fs";
import path from "node:path";

// memoryIds become directory names, so anything that could escape the
// configured baseDir (path separators, leading dots, control chars) must
// be rejected. We allow letters, digits, dash, underscore, and dot — but
// disallow segments that are exactly ".", "..", or contain a slash.
const MEMORY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateMemoryId(memoryId: string): void {
  if (
    !memoryId ||
    memoryId === "." ||
    memoryId === ".." ||
    !MEMORY_ID_PATTERN.test(memoryId)
  ) {
    throw new Error(
      `Invalid memoryId "${memoryId}". memoryIds must match ${MEMORY_ID_PATTERN} and cannot be "." or "..".`,
    );
  }
}

export class FileMemoryStore implements MemoryStore {
  constructor(private baseDir: string) {}

  private dir(memoryId: string): string {
    validateMemoryId(memoryId);
    return path.join(this.baseDir, memoryId);
  }

  private ensureDir(memoryId: string): void {
    const dir = this.dir(memoryId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async readJSON<T>(filePath: string): Promise<T | null> {
    if (!fs.existsSync(filePath)) return null;
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content);
  }

  private async writeJSON(filePath: string, data: unknown): Promise<void> {
    await fs.promises.writeFile(
      filePath,
      JSON.stringify(data, null, 2),
      "utf-8"
    );
  }

  async loadGraph(memoryId: string): Promise<MemoryGraphData> {
    const filePath = path.join(this.dir(memoryId), "graph.json");
    const data = await this.readJSON<MemoryGraphData>(filePath);
    return data ?? { entities: [], relations: [], nextId: 1 };
  }

  async saveGraph(memoryId: string, graph: MemoryGraphData): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "graph.json");
    await this.writeJSON(filePath, graph);
  }

  async loadEmbeddings(memoryId: string): Promise<EmbeddingIndex | null> {
    const filePath = path.join(this.dir(memoryId), "embeddings.json");
    return this.readJSON<EmbeddingIndex>(filePath);
  }

  async saveEmbeddings(
    memoryId: string,
    index: EmbeddingIndex
  ): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "embeddings.json");
    await this.writeJSON(filePath, index);
  }

  async loadSummary(memoryId: string): Promise<ConversationSummary | null> {
    const filePath = path.join(this.dir(memoryId), "summary.json");
    return this.readJSON<ConversationSummary>(filePath);
  }

  async saveSummary(
    memoryId: string,
    summary: ConversationSummary
  ): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "summary.json");
    await this.writeJSON(filePath, summary);
  }
}
