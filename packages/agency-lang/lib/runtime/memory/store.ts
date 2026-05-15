import type {
  MemoryGraphData,
  ConversationSummary,
  EmbeddingIndex,
  MemoryStore,
} from "./types.js";
import {
  MemoryGraphDataSchema,
  EmbeddingIndexSchema,
  ConversationSummarySchema,
} from "./types.js";
import type { z } from "zod";
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

  // Run a Zod schema over `data` and throw a helpful, debuggable error
  // if the shape is wrong. We include the file path + the failing
  // field path(s) so a corrupted file can be located and inspected.
  private validate<T>(
    schema: z.ZodType<T>,
    data: unknown,
    filePath: string,
    direction: "load" | "save",
  ): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new Error(
        `MemoryStore ${direction} schema mismatch at ${filePath}: ${issues}`,
      );
    }
    return result.data;
  }

  private async readJSON(filePath: string): Promise<unknown | null> {
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
    const raw = await this.readJSON(filePath);
    if (raw === null) return { entities: [], relations: [], nextId: 1 };
    return this.validate(MemoryGraphDataSchema, raw, filePath, "load");
  }

  async saveGraph(memoryId: string, graph: MemoryGraphData): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "graph.json");
    this.validate(MemoryGraphDataSchema, graph, filePath, "save");
    await this.writeJSON(filePath, graph);
  }

  async loadEmbeddings(memoryId: string): Promise<EmbeddingIndex | null> {
    const filePath = path.join(this.dir(memoryId), "embeddings.json");
    const raw = await this.readJSON(filePath);
    if (raw === null) return null;
    return this.validate(EmbeddingIndexSchema, raw, filePath, "load");
  }

  async saveEmbeddings(
    memoryId: string,
    index: EmbeddingIndex
  ): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "embeddings.json");
    this.validate(EmbeddingIndexSchema, index, filePath, "save");
    await this.writeJSON(filePath, index);
  }

  async loadSummary(memoryId: string): Promise<ConversationSummary | null> {
    const filePath = path.join(this.dir(memoryId), "summary.json");
    const raw = await this.readJSON(filePath);
    if (raw === null) return null;
    return this.validate(ConversationSummarySchema, raw, filePath, "load");
  }

  async saveSummary(
    memoryId: string,
    summary: ConversationSummary
  ): Promise<void> {
    this.ensureDir(memoryId);
    const filePath = path.join(this.dir(memoryId), "summary.json");
    this.validate(ConversationSummarySchema, summary, filePath, "save");
    await this.writeJSON(filePath, summary);
  }
}
