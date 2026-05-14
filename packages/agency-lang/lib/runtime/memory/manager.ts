import type {
  MemoryConfig,
  MemoryStore as MemoryStoreType,
  ConversationSummary,
  MemoryMessage,
} from "./types.js";
import { MemoryGraph } from "./graph.js";
import { EmbeddingManager } from "./embeddings.js";
import { buildExtractionPrompt, applyExtractionResult } from "./extraction.js";
import type { ExtractionResult } from "./extraction.js";
import {
  structuredLookup,
  formatRetrievalResults,
  buildRetrievalPrompt,
} from "./retrieval.js";
import {
  shouldCompact,
  buildCompactionPrompt,
  buildMergeSummaryPrompt,
  findCompactionSplitPoint,
} from "./compaction.js";

/**
 * The minimal LLM client interface the MemoryManager depends on.
 * Adapters wrap smoltalk to satisfy this shape.
 */
export type LlmClient = {
  text(prompt: string, options?: { model?: string }): Promise<string>;
  embed?(text: string, options?: { model?: string }): Promise<number[]>;
};

/**
 * A pluggable reference to the active memoryId.
 *
 * Per resolved decision #1, in production this is backed by
 * `stateStack.other.memoryId` so it survives interrupt/resume. For tests
 * an in-memory ref is used.
 */
export type MemoryIdRef = {
  get(): string;
  set(id: string): void;
};

function createInMemoryRef(initial = "default"): MemoryIdRef {
  let id = initial;
  return {
    get: () => id,
    set: (value: string) => {
      id = value;
    },
  };
}

export type MemoryManagerOptions = {
  store: MemoryStoreType;
  config: MemoryConfig;
  llmClient: LlmClient;
  source?: string;
  memoryIdRef?: MemoryIdRef;
};

type CacheEntry = {
  graph: MemoryGraph;
  embeddings: EmbeddingManager;
  summary: ConversationSummary | null;
  turnsSinceExtraction: number;
};

const DEFAULT_RECALL_K = 10;
const DEFAULT_EMBEDDING_THRESHOLD = 0.3;

export class MemoryManager {
  private store: MemoryStoreType;
  private config: MemoryConfig;
  private llmClient: LlmClient;
  private source: string;
  private memoryIdRef: MemoryIdRef;

  // Per-memoryId cache; switching id selects a different entry rather
  // than discarding state (resolved decision #2).
  private cache: Record<string, CacheEntry> = {};

  constructor(options: MemoryManagerOptions) {
    this.store = options.store;
    this.config = options.config;
    this.llmClient = options.llmClient;
    this.source = options.source ?? "unknown";
    this.memoryIdRef = options.memoryIdRef ?? createInMemoryRef();
  }

  getMemoryId(): string {
    return this.memoryIdRef.get();
  }

  setMemoryId(id: string): void {
    this.memoryIdRef.set(id);
  }

  isInitialized(): boolean {
    return this.cache[this.getMemoryId()] !== undefined;
  }

  /**
   * Returns the graph for the active memoryId. Throws if the cache
   * has not been loaded yet (call init() or any async operation first).
   */
  getGraph(): MemoryGraph {
    const entry = this.cache[this.getMemoryId()];
    if (!entry) {
      throw new Error(
        `MemoryManager not initialized for memoryId "${this.getMemoryId()}". Call init() first.`
      );
    }
    return entry.graph;
  }

  async init(): Promise<void> {
    await this.getEntry();
  }

  private async getEntry(): Promise<CacheEntry> {
    const id = this.getMemoryId();
    const existing = this.cache[id];
    if (existing) return existing;

    const graphData = await this.store.loadGraph(id);
    const graph = MemoryGraph.fromJSON(graphData);

    const embeddingIndex = await this.store.loadEmbeddings(id);
    const embeddings = embeddingIndex
      ? EmbeddingManager.fromIndex(embeddingIndex)
      : new EmbeddingManager();
    if (this.config.embeddings?.model) {
      embeddings.setModel(this.config.embeddings.model);
    }

    const summary = await this.store.loadSummary(id);
    const entry: CacheEntry = {
      graph,
      embeddings,
      summary,
      turnsSinceExtraction: 0,
    };
    this.cache[id] = entry;
    return entry;
  }

  private model(): string {
    return this.config.model ?? "gpt-4o-mini";
  }

  async remember(content: string): Promise<void> {
    const entry = await this.getEntry();
    const messages: MemoryMessage[] = [{ role: "user", content }];
    const prompt = buildExtractionPrompt(messages, entry.graph);
    const response = await this.llmClient.text(prompt, { model: this.model() });
    const result = parseJSON<ExtractionResult>(response);
    if (!result) return;
    const newObsIds = applyExtractionResult(entry.graph, result, this.source);
    await this.generateEmbeddings(entry, newObsIds);
    await this.persist(entry);
  }

  async recall(query: string, options?: { model?: string }): Promise<string> {
    const entry = await this.getEntry();

    // Run all three tiers and union the results, deduping by entity id.
    // Order: structured matches first, then embedding matches, then LLM.
    const orderedIds: string[] = [];

    const tier1 = structuredLookup(entry.graph, query);
    for (const e of tier1) {
      if (!orderedIds.includes(e.id)) orderedIds.push(e.id);
    }

    const tier2EntityIds = await this.embeddingRecallEntityIds(entry, query);
    for (const id of tier2EntityIds) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }

    const model = options?.model ?? this.model();
    const tier3EntityIds = await this.llmRecallEntityIds(entry, query, model);
    for (const id of tier3EntityIds) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }

    const topK = orderedIds.slice(0, DEFAULT_RECALL_K);
    const entities = topK
      .map((id) => entry.graph.getEntity(id))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return formatRetrievalResults(entry.graph, entities);
  }

  async recallForInjection(query: string): Promise<string> {
    const entry = await this.getEntry();

    // Tiers 1+2 only for low latency (resolved decision #4).
    const orderedIds: string[] = [];

    const tier1 = structuredLookup(entry.graph, query);
    for (const e of tier1) {
      if (!orderedIds.includes(e.id)) orderedIds.push(e.id);
    }

    const tier2EntityIds = await this.embeddingRecallEntityIds(entry, query);
    for (const id of tier2EntityIds) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }

    const topK = orderedIds.slice(0, DEFAULT_RECALL_K);
    const entities = topK
      .map((id) => entry.graph.getEntity(id))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return formatRetrievalResults(entry.graph, entities);
  }

  async forget(query: string): Promise<void> {
    const entry = await this.getEntry();
    const prompt = `Given the following knowledge graph, identify which observations should be expired based on the user's request.

Knowledge graph:
${entry.graph.toCompactIndex()}

User wants to forget: ${query}

Return a JSON array of { entityName, observationContent } for observations to expire. Return [] if nothing matches.`;
    const response = await this.llmClient.text(prompt, { model: this.model() });
    const expirations = parseJSON<
      Array<{ entityName: string; observationContent: string }>
    >(response);
    if (!expirations) return;

    // forget uses substring matching, case-insensitive (resolved decision #7)
    for (const exp of expirations) {
      const entity = entry.graph.findEntityByName(exp.entityName);
      if (!entity) continue;
      const obs = entity.observations.find(
        (o) =>
          o.validTo === null &&
          o.content
            .toLowerCase()
            .includes(exp.observationContent.toLowerCase())
      );
      if (obs) entry.graph.expireObservation(obs.id);
    }
    await this.persist(entry);
  }

  async onTurn(messages: MemoryMessage[]): Promise<void> {
    const entry = await this.getEntry();
    entry.turnsSinceExtraction++;
    const interval = this.config.autoExtract?.interval ?? 5;
    if (entry.turnsSinceExtraction >= interval) {
      await this.autoExtract(entry, messages);
      entry.turnsSinceExtraction = 0;
    }
  }

  async compactIfNeeded(
    messages: MemoryMessage[]
  ): Promise<MemoryMessage[] | null> {
    const entry = await this.getEntry();
    const compactionConfig = {
      trigger: this.config.compaction?.trigger ?? ("token" as const),
      threshold: this.config.compaction?.threshold ?? 50000,
    };
    if (!shouldCompact(messages, compactionConfig)) return null;

    // Preserve any system messages at the head verbatim.
    let systemPrefixEnd = 0;
    while (
      systemPrefixEnd < messages.length &&
      messages[systemPrefixEnd].role === "system"
    ) {
      systemPrefixEnd++;
    }
    const systemPrefix = messages.slice(0, systemPrefixEnd);
    const conversation = messages.slice(systemPrefixEnd);

    // Find a clean split point that does not break a tool_call/tool sequence.
    const splitInConv = findCompactionSplitPoint(conversation);
    if (splitInConv === -1) return null;

    const toCompact = conversation.slice(0, splitInConv);
    const toKeep = conversation.slice(splitInConv);

    // Drop tool_call / tool messages from the prefix; their info will be
    // captured in the natural-language summary (resolved decision #5).
    const naturalForSummary = toCompact.filter(
      (m) => m.role !== "tool"
    );

    // Extract facts from the prefix before compacting.
    await this.autoExtract(entry, toCompact);

    const compactionPrompt = buildCompactionPrompt(naturalForSummary);
    let newSummary = await this.llmClient.text(compactionPrompt, {
      model: this.model(),
    });

    if (entry.summary) {
      const mergePrompt = buildMergeSummaryPrompt(
        entry.summary.summary,
        newSummary
      );
      newSummary = await this.llmClient.text(mergePrompt, {
        model: this.model(),
      });
    }

    entry.summary = {
      summary: newSummary,
      lastCompactedAt: new Date().toISOString(),
      messagesSummarized:
        (entry.summary?.messagesSummarized ?? 0) + toCompact.length,
    };

    await this.persist(entry);

    const summaryMessage: MemoryMessage = {
      role: "system",
      content: `Previous conversation summary:\n${newSummary}`,
    };
    return [...systemPrefix, summaryMessage, ...toKeep];
  }

  /** Persist all cached memoryIds to disk. */
  async save(): Promise<void> {
    for (const [id, entry] of Object.entries(this.cache)) {
      await this.persistEntry(id, entry);
    }
  }

  // ---- internals ----

  private async persist(entry: CacheEntry): Promise<void> {
    await this.persistEntry(this.getMemoryId(), entry);
  }

  private async persistEntry(id: string, entry: CacheEntry): Promise<void> {
    await this.store.saveGraph(id, entry.graph.toJSON());
    await this.store.saveEmbeddings(id, entry.embeddings.toIndex());
    if (entry.summary) {
      await this.store.saveSummary(id, entry.summary);
    }
  }

  private async autoExtract(
    entry: CacheEntry,
    messages: MemoryMessage[]
  ): Promise<void> {
    const prompt = buildExtractionPrompt(messages, entry.graph);
    const response = await this.llmClient.text(prompt, { model: this.model() });
    const result = parseJSON<ExtractionResult>(response);
    if (!result) return;
    const newObsIds = applyExtractionResult(entry.graph, result, this.source);
    await this.generateEmbeddings(entry, newObsIds);
    await this.persist(entry);
  }

  private async generateEmbeddings(
    entry: CacheEntry,
    observationIds: string[]
  ): Promise<void> {
    if (!this.llmClient.embed) return;
    for (const obsId of observationIds) {
      const obsContent = findObservationContent(entry.graph, obsId);
      if (!obsContent) continue;
      try {
        const vector = await this.llmClient.embed(obsContent, {
          model: this.config.embeddings?.model,
        });
        entry.embeddings.addEntry(obsId, vector);
      } catch {
        // Embedding failed — Tier 2 silently no-ops (resolved decision #8).
      }
    }
  }

  private async embeddingRecallEntityIds(
    entry: CacheEntry,
    query: string
  ): Promise<string[]> {
    if (!this.llmClient.embed) return [];
    let queryVector: number[];
    try {
      queryVector = await this.llmClient.embed(query, {
        model: this.config.embeddings?.model,
      });
    } catch {
      return [];
    }
    const similar = entry.embeddings.findSimilar(
      queryVector,
      DEFAULT_RECALL_K,
      DEFAULT_EMBEDDING_THRESHOLD
    );
    if (similar.length === 0) return [];

    const entityIds: string[] = [];
    for (const result of similar) {
      for (const e of entry.graph.getEntities()) {
        if (e.observations.some((o) => o.id === result.id)) {
          if (!entityIds.includes(e.id)) entityIds.push(e.id);
          break;
        }
      }
    }
    return entityIds;
  }

  private async llmRecallEntityIds(
    entry: CacheEntry,
    query: string,
    model: string
  ): Promise<string[]> {
    if (entry.graph.getEntities().length === 0) return [];
    const retrievalPrompt = buildRetrievalPrompt(query, entry.graph);
    const response = await this.llmClient.text(retrievalPrompt, { model });
    const entityNames = parseJSON<string[]>(response);
    if (!entityNames) return [];
    const ids: string[] = [];
    for (const name of entityNames) {
      const e = entry.graph.findEntityByName(name);
      if (e && !ids.includes(e.id)) ids.push(e.id);
    }
    return ids;
  }
}

function parseJSON<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function findObservationContent(
  graph: MemoryGraph,
  obsId: string
): string | null {
  for (const entity of graph.getEntities()) {
    const obs = entity.observations.find((o) => o.id === obsId);
    if (obs) return obs.content;
  }
  return null;
}
