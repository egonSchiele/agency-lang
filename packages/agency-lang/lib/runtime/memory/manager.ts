import { z } from "zod";
import * as smoltalk from "smoltalk";
import type { SmolConfig } from "smoltalk";
import type {
  MemoryConfig,
  MemoryStore as MemoryStoreType,
  ConversationSummary,
} from "./types.js";
import { MemoryGraph } from "./graph.js";
import { EmbeddingManager } from "./embeddings.js";
import {
  buildExtractionPrompt,
  applyExtractionResult,
  parseExtractionResult,
} from "./extraction.js";
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
import { MEMORY_COMPACTION_DEFAULT_THRESHOLD } from "../../constants.js";
import forgetTemplate from "../../templates/prompts/memory/forget.js";
import type { LLMClient } from "../llmClient.js";

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

// Default MemoryIdRef used when callers don't supply one (i.e. tests
// constructing MemoryManager directly). Production wires the ref to
// `stateStack.other.memoryId` inline in `forkExecCtx` (lib/runtime/
// state/context.ts) so the active id survives interrupt/resume; that
// path requires a fully-constructed execCtx, which tests for the
// MemoryManager unit don't want to set up. Keeping a tiny in-memory
// ref here lets unit tests stay focused on the manager behaviour.
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
  /** The runtime-wide LLMClient (`SmoltalkClient`, `DeterministicClient`,
   *  or whatever the user registered via `setLLMClient`). MemoryManager
   *  uses it directly so registering a custom client takes effect for
   *  memory's text + embed calls too. */
  llmClient: LLMClient;
  /** Default `SmolConfig` overrides (api keys, provider, etc.). Merged
   *  into every text and embed call. */
  smoltalkDefaults?: Partial<SmolConfig>;
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
  // observationId -> entityId reverse index. Maintained alongside
  // graph mutations (add/expire) so Tier-2 embedding recall can map
  // similarity hits back to entities in O(1) instead of scanning all
  // entities * observations every recall.
  obsToEntity: Record<string, string>;
};

const DEFAULT_RECALL_K = 10;
const DEFAULT_EMBEDDING_THRESHOLD = 0.3;
const SUMMARY_MESSAGE_PREFIX = "Previous conversation summary:\n";

/**
 * Plan describing how the caller should reshape its message thread
 * after compaction. The MemoryManager returns indices, not message
 * instances, so the caller can rebuild the thread from its own
 * smoltalk.Message instances and preserve identity (===). That keeps
 * any caller-side maps keyed on message identity (e.g. trace
 * correlations) valid across compaction.
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
  private llmClient: LLMClient;
  private smoltalkDefaults: Partial<SmolConfig>;
  private source: string;
  private memoryIdRef: MemoryIdRef;

  // Per-memoryId cache; switching id selects a different entry rather
  // than discarding state (resolved decision #2). We use a null-prototype
  // object so user-controlled memoryIds like "__proto__" or "constructor"
  // can't collide with Object.prototype methods or pollute the prototype.
  //
  // Lifecycle: entries are loaded lazily by `getEntry()` on the first
  // use of a given memoryId, never evicted, and never shared across
  // MemoryManager instances. The runtime constructs one MemoryManager
  // per execution context, so per-instance caching is the correct
  // boundary — concurrent flows in different contexts each get their
  // own snapshot and their own write surface.
  private cache: Record<string, CacheEntry> = Object.create(null);

  constructor(options: MemoryManagerOptions) {
    this.store = options.store;
    this.config = options.config;
    this.llmClient = options.llmClient;
    this.smoltalkDefaults = options.smoltalkDefaults ?? {};
    this.source = options.source ?? "unknown";
    this.memoryIdRef = options.memoryIdRef ?? createInMemoryRef();
  }

  /**
   * Run a single-prompt text completion through the registered
   * LLMClient. We always go through `llmClient.text` (not directly
   * to smoltalk) so a custom client registered via `setLLMClient`
   * — including the `DeterministicClient` used in tests — controls
   * memory's text calls too.
   */
  private async _text(
    prompt: string,
    options?: { model?: string },
  ): Promise<string> {
    const result = await this.llmClient.text({
      ...this.smoltalkDefaults,
      messages: [smoltalk.userMessage(prompt)],
      model: options?.model ?? this.smoltalkDefaults.model,
    } as any);
    if (!result.success) {
      throw new Error(`memory llm text call failed: ${result.error}`);
    }
    return result.value.output ?? "";
  }

  /** Same routing as _text(), but for embeddings. Returns a single
   *  vector (the LLMClient.embed protocol accepts string|string[]; we
   *  always pass one string here so the response is one vector). */
  private async _embed(
    text: string,
    options?: { model?: string },
  ): Promise<number[]> {
    const result = await this.llmClient.embed(text, {
      model: options?.model,
      openAiApiKey: (this.smoltalkDefaults as any).openAiApiKey,
      googleApiKey: (this.smoltalkDefaults as any).googleApiKey,
    });
    if (!result.success) {
      throw new Error(`memory embed call failed: ${result.error}`);
    }
    const vector = result.value.embeddings[0];
    if (!vector) throw new Error("memory embed returned no vectors");
    return vector;
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
      // `!configuredModel` means the user hasn't pinned an embedding
      // model in their config, so we trust whatever the on-disk index
      // was built with. This branch is hit at most once per memoryId
      // per MemoryManager instance — the cache check at the top of
      // getEntry() short-circuits subsequent calls — so there's no
      // risk of repeated rebuilds.
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
    const obsToEntity: Record<string, string> = Object.create(null);
    for (const e of graph.getEntities()) {
      for (const o of e.observations) {
        obsToEntity[o.id] = e.id;
      }
    }
    const entry: CacheEntry = {
      memoryId: id,
      graph,
      embeddings,
      summary,
      turnsSinceExtraction: 0,
      obsToEntity,
    };
    this.cache[id] = entry;
    return entry;
  }

  // Resolution order: explicit `memory.model` > top-level `defaultModel`
  // (passed in via `smoltalkDefaults.model` from AgencyConfig) >
  // hardcoded fallback. Documented at the type level on
  // `MemoryConfig.model` and on the `MemoryManagerOptions.smoltalkDefaults`
  // field. Tests asserting a specific model should set `memory.model`.
  private model(): string {
    if (this.config.model) return this.config.model;
    const smoltalkModel = (this.smoltalkDefaults as { model?: string }).model;
    if (smoltalkModel) return smoltalkModel;
    return "gpt-4o-mini";
  }

  async remember(content: string): Promise<void> {
    const entry = await this.getEntry();
    const messages: smoltalk.Message[] = [smoltalk.userMessage(content)];
    const prompt = buildExtractionPrompt(messages, entry.graph);
    const response = await this._text(prompt, { model: this.model() });
    const result = parseExtractionResult(response);
    if (!result) return;
    const outcome = applyExtractionResult(entry.graph, result, this.source);
    for (const id of outcome.expiredObservationIds) {
      entry.embeddings.removeEntry(id);
    }
    this.indexNewObservations(entry, outcome.newObservationIds);
    await this.generateEmbeddings(entry, outcome.newObservationIds);
    await this.persist(entry);
  }

  // Run the cheap tiers (structured lookup + embedding similarity) and
  // return entity ids in priority order, deduped. Used by both
  // `recall` (which then layers Tier 3 LLM recall on top) and
  // `recallForInjection` (which intentionally stops here for latency).
  private async tier1And2(
    entry: CacheEntry,
    query: string
  ): Promise<string[]> {
    const orderedIds: string[] = [];

    const tier1 = structuredLookup(entry.graph, query);
    for (const e of tier1) {
      if (!orderedIds.includes(e.id)) orderedIds.push(e.id);
    }

    const tier2EntityIds = await this.embeddingRecallEntityIds(entry, query);
    for (const id of tier2EntityIds) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }

    return orderedIds;
  }

  async recall(query: string, options?: { model?: string }): Promise<string> {
    const entry = await this.getEntry();

    // Order: structured matches first, then embedding matches, then LLM.
    const orderedIds = await this.tier1And2(entry, query);

    // If tiers 1+2 already filled the top-K window, skip the LLM call —
    // any tier 3 results would be sliced off below anyway, and the LLM
    // round-trip dominates the recall latency budget.
    if (orderedIds.length < DEFAULT_RECALL_K) {
      // Tier 3 is best-effort like Tier 2: a provider error here must not
      // throw away results we already have from tiers 1 and 2.
      const model = options?.model ?? this.model();
      try {
        const tier3EntityIds = await this.llmRecallEntityIds(
          entry,
          query,
          model,
        );
        for (const id of tier3EntityIds) {
          if (!orderedIds.includes(id)) orderedIds.push(id);
        }
      } catch (err) {
        // Tier 1 + 2 results still get returned below; surface the
        // failure so it shows up in logs / traces rather than vanishing.
        console.warn(
          `[memory] tier 3 (LLM recall) failed for query=${JSON.stringify(query)}: ${(err as Error).message}`,
        );
      }
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
    const orderedIds = await this.tier1And2(entry, query);

    const topK = orderedIds.slice(0, DEFAULT_RECALL_K);
    const entities = topK
      .map((id) => entry.graph.getEntity(id))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return formatRetrievalResults(entry.graph, entities);
  }

  async forget(query: string): Promise<void> {
    const entry = await this.getEntry();
    const prompt = forgetTemplate({
      graphIndex: entry.graph.toCompactIndex(),
      query,
    });
    const response = await this._text(prompt, { model: this.model() });
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

  async onTurn(messages: smoltalk.Message[]): Promise<void> {
    const entry = await this.getEntry();
    entry.turnsSinceExtraction++;
    const interval = this.config.autoExtract?.interval ?? 5;
    if (entry.turnsSinceExtraction >= interval) {
      await this.autoExtract(entry, messages);
      entry.turnsSinceExtraction = 0;
    }
  }

  async compactIfNeeded(
    messages: smoltalk.Message[]
  ): Promise<CompactionPlan | null> {
    const entry = await this.getEntry();
    const compactionConfig = {
      trigger: this.config.compaction?.trigger ?? ("token" as const),
      threshold:
        this.config.compaction?.threshold ?? MEMORY_COMPACTION_DEFAULT_THRESHOLD,
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
    if (splitInConv === -1) {
      // No clean split — log enough to debug what the conversation
      // shape was so users can tell why their thread isn't being
      // compacted (e.g. mostly assistant + tool messages with no
      // user turns past the midpoint).
      console.warn(
        `[memory] compaction skipped: no clean split point found. messages=${JSON.stringify(messages)}`,
      );
      return null;
    }

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
    let newSummary = await this._text(compactionPrompt, {
      model: this.model(),
    });

    if (entry.summary) {
      const mergePrompt = buildMergeSummaryPrompt(
        entry.summary.summary,
        newSummary
      );
      newSummary = await this._text(mergePrompt, {
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
    messages: smoltalk.Message[]
  ): Promise<void> {
    const prompt = buildExtractionPrompt(messages, entry.graph);
    const response = await this._text(prompt, { model: this.model() });
    const result = parseExtractionResult(response);
    if (!result) return;
    const outcome = applyExtractionResult(entry.graph, result, this.source);
    for (const id of outcome.expiredObservationIds) {
      entry.embeddings.removeEntry(id);
    }
    this.indexNewObservations(entry, outcome.newObservationIds);
    await this.generateEmbeddings(entry, outcome.newObservationIds);
    await this.persist(entry);
  }

  // Update the cached `obsToEntity` reverse index for newly-added
  // observations. Called after every `applyExtractionResult` so the
  // index stays in sync with the graph without us having to rebuild
  // from scratch on each recall.
  private indexNewObservations(
    entry: CacheEntry,
    observationIds: string[]
  ): void {
    if (observationIds.length === 0) return;
    const wanted: Record<string, true> = Object.create(null);
    for (const id of observationIds) wanted[id] = true;
    for (const e of entry.graph.getEntities()) {
      for (const o of e.observations) {
        if (wanted[o.id]) entry.obsToEntity[o.id] = e.id;
      }
    }
  }

  private async generateEmbeddings(
    entry: CacheEntry,
    observationIds: string[]
  ): Promise<void> {
    for (const obsId of observationIds) {
      const obsContent = findObservationContent(entry.graph, obsId);
      if (!obsContent) continue;
      try {
        const vector = await this._embed(obsContent, {
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
    let queryVector: number[];
    try {
      queryVector = await this._embed(query, {
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

    // O(k) lookup via the maintained reverse index instead of O(E*O*k).
    const entityIds: string[] = [];
    for (const result of similar) {
      const entityId = entry.obsToEntity[result.id];
      if (entityId && !entityIds.includes(entityId)) {
        entityIds.push(entityId);
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
    const response = await this._text(retrievalPrompt, { model });
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

// Schema for the JSON returned by the Tier-3 (LLM) recall pass — just
// a list of entity names. Used by `parseStringArray` below.
const StringArraySchema = z.array(z.string());

function parseStringArray(text: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = StringArraySchema.safeParse(raw);
  return result.success ? result.data : null;
}

// Schema for the JSON returned by the `forget()` LLM call. Wrapped
// in a typed parse so a malformed response degrades to a no-op
// rather than throwing.
const ForgetResultSchema = z.object({
  observations: z.array(
    z.object({
      entityName: z.string(),
      observationContent: z.string(),
    }),
  ),
  relations: z.array(
    z.object({
      fromName: z.string(),
      toName: z.string(),
      type: z.string(),
    }),
  ),
});

type ForgetResult = z.infer<typeof ForgetResultSchema>;

function parseForgetResult(text: string): ForgetResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = ForgetResultSchema.safeParse(raw);
  if (!result.success) {
    console.warn(
      `[memory] forget parse failed: ${result.error.message}`,
    );
    return null;
  }
  return result.data;
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
