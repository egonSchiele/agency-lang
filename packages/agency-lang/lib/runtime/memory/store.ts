import type { MemoryGraphData, ConversationSummary, EmbeddingIndex, MemoryStore } from "./types.js";
import { MemoryGraphDataSchema, EmbeddingIndexSchema, ConversationSummarySchema } from "./types.js";
import type { z } from "zod";
import path from "node:path";
import type { HostFiles, Root } from "../../host/host.js";
import { createLogger, type Logger, type LogLevel } from "../../logger.js";

// memoryIds become directory names, so anything that could escape the
// configured baseDir (path separators, leading dots, control chars) must
// be rejected. We allow letters, digits, dash, underscore, and dot — but
// disallow segments that are exactly ".", "..", or contain a slash.
const MEMORY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateMemoryId(memoryId: string): void {
  if (!memoryId || memoryId === "." || memoryId === ".." || !MEMORY_ID_PATTERN.test(memoryId)) {
    throw new Error(
      `Invalid memoryId "${memoryId}". memoryIds must match ${MEMORY_ID_PATTERN} and cannot be "." or "..".`,
    );
  }
}

/** Where the files of a memory store live: the files part of the host
 *  that enabled memory, and the memory directory as a root in it. */
export class FileMemoryStore implements MemoryStore {
  /** Built once in the constructor from `logLevel`. Each line emitted
   *  is `[memory]`-prefixed so it groups with the manager's output
   *  when grepping. */
  private logger: Logger;
  /** The memory directory as a root, resolved on first use. The
   *  directory exists by then: `MemoryFrame` created it. */
  private baseRoot: Promise<Root> | null = null;

  constructor(
    private files: HostFiles,
    private baseDir: string,
    logLevel?: LogLevel,
  ) {
    this.logger = createLogger(logLevel ?? "info");
  }

  private root(): Promise<Root> {
    if (this.baseRoot === null) {
      this.baseRoot = this.files.root(this.baseDir);
    }
    return this.baseRoot;
  }

  /** The path of a memory's file, relative to the memory directory. */
  private file(memoryId: string, name: string): string {
    validateMemoryId(memoryId);
    return path.join(memoryId, name);
  }

  /** The whole path of a memory's file, for a message. */
  private describe(memoryId: string, name: string): string {
    return path.join(this.baseDir, memoryId, name);
  }

  private async ensureDir(memoryId: string): Promise<void> {
    validateMemoryId(memoryId);
    const root = await this.root();
    if ((await this.files.stat(root, memoryId)) === null) {
      await this.files.mkdir(root, memoryId);
      this.logger.debug(`[memory] FileMemoryStore: mkdir ${path.join(this.baseDir, memoryId)}`);
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
      throw new Error(`MemoryStore ${direction} schema mismatch at ${filePath}: ${issues}`);
    }
    return result.data;
  }

  private async readJSON(memoryId: string, name: string): Promise<unknown | null> {
    const file = this.file(memoryId, name);
    const root = await this.root();
    if ((await this.files.stat(root, file)) === null) {
      this.logger.debug(`[memory] FileMemoryStore: read miss ${this.describe(memoryId, name)}`);
      return null;
    }
    const content = await this.files.readText(root, file);
    this.logger.debug(
      `[memory] FileMemoryStore: read ${this.describe(memoryId, name)} (${content.length} bytes)`,
    );
    return JSON.parse(content);
  }

  private async writeJSON(memoryId: string, name: string, data: unknown): Promise<void> {
    const serialized = JSON.stringify(data, null, 2);
    await this.files.writeText(await this.root(), this.file(memoryId, name), serialized);
    this.logger.debug(
      `[memory] FileMemoryStore: wrote ${this.describe(memoryId, name)} (${serialized.length} bytes)`,
    );
  }

  async loadGraph(memoryId: string): Promise<MemoryGraphData> {
    const raw = await this.readJSON(memoryId, "graph.json");
    if (raw === null) return { entities: [], relations: [], nextId: 1 };
    return this.validate(MemoryGraphDataSchema, raw, this.describe(memoryId, "graph.json"), "load");
  }

  async saveGraph(memoryId: string, graph: MemoryGraphData): Promise<void> {
    await this.ensureDir(memoryId);
    this.validate(MemoryGraphDataSchema, graph, this.describe(memoryId, "graph.json"), "save");
    await this.writeJSON(memoryId, "graph.json", graph);
  }

  async loadEmbeddings(memoryId: string): Promise<EmbeddingIndex | null> {
    const raw = await this.readJSON(memoryId, "embeddings.json");
    if (raw === null) return null;
    return this.validate(
      EmbeddingIndexSchema,
      raw,
      this.describe(memoryId, "embeddings.json"),
      "load",
    );
  }

  async saveEmbeddings(memoryId: string, index: EmbeddingIndex): Promise<void> {
    await this.ensureDir(memoryId);
    this.validate(EmbeddingIndexSchema, index, this.describe(memoryId, "embeddings.json"), "save");
    await this.writeJSON(memoryId, "embeddings.json", index);
  }

  async loadSummary(memoryId: string): Promise<ConversationSummary | null> {
    const raw = await this.readJSON(memoryId, "summary.json");
    if (raw === null) return null;
    return this.validate(
      ConversationSummarySchema,
      raw,
      this.describe(memoryId, "summary.json"),
      "load",
    );
  }

  async saveSummary(memoryId: string, summary: ConversationSummary): Promise<void> {
    await this.ensureDir(memoryId);
    this.validate(
      ConversationSummarySchema,
      summary,
      this.describe(memoryId, "summary.json"),
      "save",
    );
    await this.writeJSON(memoryId, "summary.json", summary);
  }
}
