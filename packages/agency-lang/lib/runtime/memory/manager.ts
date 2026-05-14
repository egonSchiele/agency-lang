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
  // Captured at load time so persists go to the same id even if a
  // concurrent setMemoryId() runs while an LLM/embed call is in flight.
  memoryId: string;
  graph: MemoryGraph;
  embeddings: EmbeddingManager;
  summary: ConversationSummary | null;
  turnsSinceExtraction: number;
};

const DEFAULT_RECALL_K = 10;
const DEFAULT_EMBEDDING_THRESHOLD = 0.3;
const SUMMARY_MESSAGE_PREFIX = "Previous conversation summary:\n";

/**
 * Plan describing how the caller should reshape its message thread
 * after compaction. The MemoryManager intentionally does not return
 * the new messages directly: callers like prompt.ts hold smoltalk
 * Message instances that carry tool_call metadata, and round-tripping
 * through `MemoryMessage` would drop that. The caller assembles the
 * new thread from its own message instances using these indices, then
 * inserts a single fresh system message containing the new summary.
 */
export type CompactionPlan = {
  /** Indices in the original messages array to keep at the head, in order.
   *  Excludes any prior summary message — that gets replaced, not stacked. */
  systemPrefixIndices: number[];
  /** Indices in the original messages array to keep verbatim at the tail,
   *  in order. These are the most recent messages preserved across the split. */
  tailIndices: number[];
  /** Full content for the new summary system message (already includes the
   *  SUMMARY_MESSAGE_PREFIX so callers can pass it straight to systemMessage). */
  summaryMessageContent: string;
};

export class MemoryManager {
  private store: MemoryStoreType;
  private config: MemoryConfig;
  private llmClient: LlmClient;
  private source: string;
  private memoryIdRef: MemoryIdRef;

  // Per-memoryId cache; switching id selects a different entry rather
  // than discarding state (resolved decision #2). We use a null-prototype
  // object so user-controlled memoryIds like "__proto__" or "constructor"
  // can't collide with Object.prototype methods or pollute the prototype.
  private cache: Record<string, CacheEntry> = Object.create(null);

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

    const configuredModel = this.config.embeddings?.model;
    const embeddingIndex = await this.store.loadEmbeddings(id);
    let embeddings: EmbeddingManager;
    if (
      embeddingIndex &&
      (!configuredModel || embeddingIndex.model === configuredModel)
    ) {
      embeddings = EmbeddingManager.fromIndex(embeddingIndex);
    } else {
      // Model mismatch (or no prior index): discard stale entries —
      // comparing query vectors from one model to stored vectors from
      // another (or different dimensions) yields garbage similarities.
      embeddings = new EmbeddingManager();
    }
    if (configuredModel) {
      embeddings.setModel(configuredModel);
    }

    const summary = await this.store.loadSummary(id);
    const entry: CacheEntry = {
      memoryId: id,
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
    const result = parseExtractionResult(response);
    if (!result) return;
    const outcome = applyExtractionResult(entry.graph, result, this.source);
    for (const id of outcome.expiredObservationIds) {
      entry.embeddings.removeEntry(id);
    }
    await this.generateEmbeddings(entry, outcome.newObservationIds);
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

    // Tier 3 is best-effort like Tier 2: a provider error here must not
    // throw away results we already have from tiers 1 and 2.
    const model = options?.model ?? this.model();
    try {
      const tier3EntityIds = await this.llmRecallEntityIds(entry, query, model);
      for (const id of tier3EntityIds) {
        if (!orderedIds.includes(id)) orderedIds.push(id);
      }
    } catch {
      // swallow — tier 1 + 2 results still get returned below
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
    const prompt = `Given the following knowledge graph, identify which facts should be expired based on the user's request.

Knowledge graph:
${entry.graph.toCompactIndex()}

User wants to forget: ${query}

Return a JSON object with two fields:
- "observations": array of { entityName, observationContent } to expire (substring match)
- "relations":    array of { fromName, toName, type } to expire

Return { "observations": [], "relations": [] } if nothing matches.`;
    const response = await this.llmClient.text(prompt, { model: this.model() });
    const parsed = parseForgetResult(response);
    if (!parsed) return;

    // forget uses substring matching, case-insensitive (resolved decision #7)
    for (const exp of parsed.observations) {
      const entity = entry.graph.findEntityByName(exp.entityName);
      if (!entity) continue;
      const obs = entity.observations.find(
        (o) =>
          o.validTo === null &&
          o.content
            .toLowerCase()
            .includes(exp.observationContent.toLowerCase()),
      );
      if (obs) {
        entry.graph.expireObservation(obs.id);
        entry.embeddings.removeEntry(obs.id);
      }
    }

    for (const exp of parsed.relations) {
      const fromEntity = entry.graph.findEntityByName(exp.fromName);
      const toEntity = entry.graph.findEntityByName(exp.toName);
      if (!fromEntity || !toEntity) continue;
      const lowerType = exp.type.toLowerCase();
      const rel = entry.graph
        .getRelations()
        .find(
          (r) =>
            r.validTo === null &&
            r.from === fromEntity.id &&
            r.to === toEntity.id &&
            r.type.toLowerCase().includes(lowerType),
        );
      if (rel) entry.graph.expireRelation(rel.id);
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
  ): Promise<CompactionPlan | null> {
    const entry = await this.getEntry();
    const compactionConfig = {
      trigger: this.config.compaction?.trigger ?? ("token" as const),
      threshold: this.config.compaction?.threshold ?? 50000,
    };
    if (!shouldCompact(messages, compactionConfig)) return null;

    // Preserve system messages at the head verbatim — but exclude any
    // previously-injected summary message. We replace it rather than
    // stack a new one beside it, so the head doesn't grow on every
    // compaction.
    let systemPrefixEnd = 0;
    while (
      systemPrefixEnd < messages.length &&
      messages[systemPrefixEnd].role === "system"
    ) {
      systemPrefixEnd++;
    }
    const systemPrefixIndices: number[] = [];
    for (let i = 0; i < systemPrefixEnd; i++) {
      if (!messages[i].content.startsWith(SUMMARY_MESSAGE_PREFIX)) {
        systemPrefixIndices.push(i);
      }
    }
    const conversation = messages.slice(systemPrefixEnd);

    // Find a clean split point that does not break a tool_call/tool sequence.
    const splitInConv = findCompactionSplitPoint(conversation);
    if (splitInConv === -1) return null;

    const toCompact = conversation.slice(0, splitInConv);
    const tailStart = systemPrefixEnd + splitInConv;
    const tailIndices: number[] = [];
    for (let i = tailStart; i < messages.length; i++) {
      tailIndices.push(i);
    }

    // Extract facts from the prefix before compacting. Note: tool
    // messages stay in `toCompact` here so the summarizer below sees
    // tool outputs (the summary then captures any facts from them);
    // the role mapping inside buildCompactionPrompt prefixes tool
    // messages naturally so the LLM can read them.
    await this.autoExtract(entry, toCompact);

    const compactionPrompt = buildCompactionPrompt(toCompact);
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

    return {
      systemPrefixIndices,
      tailIndices,
      summaryMessageContent: `${SUMMARY_MESSAGE_PREFIX}${newSummary}`,
    };
  }

  /** Persist all cached memoryIds to disk. */
  async save(): Promise<void> {
    for (const entry of Object.values(this.cache)) {
      await this.persist(entry);
    }
  }

  // ---- internals ----

  private async persist(entry: CacheEntry): Promise<void> {
    // Always persist using the id captured when the entry was loaded,
    // never `this.getMemoryId()` — a concurrent setMemoryId() during an
    // in-flight LLM/embed call would otherwise route this user's data
    // to a different memory namespace.
    const id = entry.memoryId;
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
    const result = parseExtractionResult(response);
    if (!result) return;
    const outcome = applyExtractionResult(entry.graph, result, this.source);
    for (const id of outcome.expiredObservationIds) {
      entry.embeddings.removeEntry(id);
    }
    await this.generateEmbeddings(entry, outcome.newObservationIds);
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
    const entityNames = parseStringArray(response);
    if (!entityNames) return [];
    const ids: string[] = [];
    for (const name of entityNames) {
      const e = entry.graph.findEntityByName(name);
      if (e && !ids.includes(e.id)) ids.push(e.id);
    }
    return ids;
  }
}

function safeParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Validate that an LLM extraction response has the shape we expect.
 * Returns null on any structural mismatch so the caller can safely
 * skip rather than throw.
 */
function parseExtractionResult(text: string): ExtractionResult | null {
  const raw = safeParseJSON(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (
    !Array.isArray(obj.entities) ||
    !Array.isArray(obj.relations) ||
    !Array.isArray(obj.expirations)
  ) {
    return null;
  }
  return obj as unknown as ExtractionResult;
}

function parseStringArray(text: string): string[] | null {
  const raw = safeParseJSON(text);
  if (!Array.isArray(raw)) return null;
  if (!raw.every((v) => typeof v === "string")) return null;
  return raw as string[];
}

type ForgetResult = {
  observations: Array<{ entityName: string; observationContent: string }>;
  relations: Array<{ fromName: string; toName: string; type: string }>;
};

function parseForgetResult(text: string): ForgetResult | null {
  const raw = safeParseJSON(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const observations = Array.isArray(obj.observations) ? obj.observations : [];
  const relations = Array.isArray(obj.relations) ? obj.relations : [];
  const validObs = observations.filter(
    (o): o is { entityName: string; observationContent: string } =>
      !!o &&
      typeof o === "object" &&
      typeof (o as any).entityName === "string" &&
      typeof (o as any).observationContent === "string",
  );
  const validRels = relations.filter(
    (r): r is { fromName: string; toName: string; type: string } =>
      !!r &&
      typeof r === "object" &&
      typeof (r as any).fromName === "string" &&
      typeof (r as any).toName === "string" &&
      typeof (r as any).type === "string",
  );
  return { observations: validObs, relations: validRels };
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
