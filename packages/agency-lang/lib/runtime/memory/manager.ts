import { z } from "zod";
import * as smoltalk from "smoltalk";
import type { SmolConfig } from "smoltalk";
import {
  EMBEDDING_FORMAT_VERSION,
  type MemoryConfig,
  type MemoryStore as MemoryStoreType,
  type ConversationSummary,
} from "./types.js";
import { MemoryGraph } from "./graph.js";
import { EmbeddingManager } from "./embeddings.js";
import { MemoryCacheEntry } from "./cacheEntry.js";
import {
  buildExtractionPrompt,
  parseExtractionResult,
} from "./extraction.js";
import type { ExtractionResult } from "./extraction.js";
import {
  structuredLookup,
  formatRetrievalResults,
} from "./retrieval.js";
import {
  shouldCompact,
  buildCompactionPrompt,
  buildMergeSummaryPrompt,
  findCompactionSplitPoint,
} from "./compaction.js";
import { MEMORY_COMPACTION_DEFAULT_THRESHOLD } from "../../constants.js";
import forgetTemplate from "../../templates/prompts/memory/forget.js";
import retrievalTemplate from "../../templates/prompts/memory/retrieval.js";
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

const DEFAULT_RECALL_K = 10;
const DEFAULT_EMBEDDING_THRESHOLD = 0.3;
const SUMMARY_MESSAGE_PREFIX = "Previous conversation summary:\n";

/**
 * When Tier 1 + Tier 2 produce no candidates, fall back to "all
 * entities" only if the graph is small enough that sending the entire
 * candidate list to the LLM is reasonable. Above this size the
 * prompt becomes too large to justify the spend, so we accept "no
 * recall" rather than blast the model with everything we know.
 *
 * Picked by intuition (entry index lines are short — ~80 chars each).
 * Promote to a `MemoryConfig` knob the day a real workload demands it.
 */
const FALLBACK_GRAPH_SIZE_LIMIT = 50;

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
  private cache: Record<string, MemoryCacheEntry> = Object.create(null);

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
    return entry.getGraph();
  }

  async init(): Promise<void> {
    await this.getEntry();
  }

  private async getEntry(): Promise<MemoryCacheEntry> {
    const id = this.getMemoryId();
    const existing = this.cache[id];
    if (existing) return existing;

    const graphData = await this.store.loadGraph(id);
    const graph = MemoryGraph.fromJSON(graphData);

    const configuredModel = this.config.embeddings?.model;
    const embeddingIndex = await this.store.loadEmbeddings(id);
    let embeddings: EmbeddingManager;
    // Reject indexes built before we contextualized embedding inputs
    // (formatVersion missing or < current). They contain vectors
    // computed from bare observation content and aren't comparable to
    // query vectors built under the new scheme — leaving them in
    // would produce semantically wrong similarity scores. The next
    // write rebuilds with the current contextualized format.
    const indexFormatOk =
      embeddingIndex !== null &&
      (embeddingIndex.formatVersion ?? 1) >= EMBEDDING_FORMAT_VERSION;
    if (
      embeddingIndex &&
      indexFormatOk &&
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
      // Model mismatch, format-version bump, or no prior index:
      // discard stale entries. Comparing query vectors built under one
      // (model, source-text) pair to stored vectors built under
      // another yields garbage similarities.
      embeddings = new EmbeddingManager();
    }
    if (configuredModel) {
      embeddings.setModel(configuredModel);
    }

    const summary = await this.store.loadSummary(id);
    const entry = new MemoryCacheEntry(id, graph, embeddings, summary);
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

  /**
   * Build the extraction prompt for a single user message. Stdlib
   * agency code calls this, hands the result to `llm()` with a typed
   * `ExtractionResult`, and then calls `applyExtractionFromLLM` —
   * keeping the LLM call itself in the agency runPrompt pipeline so
   * tracing, cost/token accounting, and the structured-output Zod
   * schema all flow through the standard path.
   */
  async buildExtractionPromptFor(content: string): Promise<string> {
    const entry = await this.getEntry();
    const messages: smoltalk.Message[] = [smoltalk.userMessage(content)];
    return buildExtractionPrompt(messages, entry.getGraph());
  }

  /**
   * Apply a typed extraction result to the active graph. Used by the
   * agency-side `remember` after it gets a structured result from
   * `llm(...)`.
   */
  async applyExtractionFromLLM(result: ExtractionResult): Promise<void> {
    const entry = await this.getEntry();
    const outcome = entry.applyExtraction(result, this.source);
    await this.generateEmbeddings(entry, outcome.newObservationIds);
    await entry.persist(this.store);
  }

  /**
   * Convenience wrapper used by tests that want the whole extraction
   * round-trip in one call. The agency runtime path goes through
   * `buildExtractionPromptFor` + `applyExtractionFromLLM` instead.
   */
  async remember(content: string): Promise<void> {
    const prompt = await this.buildExtractionPromptFor(content);
    const response = await this._text(prompt, { model: this.model() });
    const result = parseExtractionResult(response);
    if (!result) return;
    await this.applyExtractionFromLLM(result);
  }

  // Run the cheap tiers (structured lookup + embedding similarity) and
  // return entity ids in priority order, deduped. Used by both
  // `recall` (which then layers Tier 3 LLM recall on top) and
  // `recallForInjection` (which intentionally stops here for latency).
  private async tier1And2(
    entry: MemoryCacheEntry,
    query: string
  ): Promise<string[]> {
    const orderedIds: string[] = [];

    const tier1 = structuredLookup(entry.getGraph(), query);
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
    const graph = entry.getGraph();
    if (graph.getEntities().length === 0) return "";

    // Stage A: cheap tiers gather candidate ids.
    let candidateIds = await this.tier1And2(entry, query);

    // Stage B (fallback): if cheap tiers found nothing AND the graph
    // is small enough to fit in the prompt without blowing tokens,
    // hand the entire graph to Tier 3 as candidates. Above the limit
    // we accept "no recall" — Tiers 1+2 should have surfaced something
    // for a graph that big, and the LLM doesn't help if every entity
    // is a candidate at scale.
    if (candidateIds.length === 0) {
      const all = graph.getEntities();
      if (all.length > FALLBACK_GRAPH_SIZE_LIMIT) return "";
      candidateIds = all.map((e) => e.id);
    }

    // Stage C: LLM relevance filter over the candidate set. The LLM
    // can only return ids from the set we offered (hallucinations are
    // dropped). Best-effort: a provider error falls back to the
    // cheap-tier order so we still return something usable.
    const model = options?.model ?? this.model();
    let relevantIds: string[];
    try {
      relevantIds = await this.llmFilterCandidates(
        entry,
        query,
        candidateIds,
        model,
      );
      // An empty filter result on a fallback (whole-graph) call most
      // likely means the LLM correctly judged nothing relevant —
      // honour that. On a non-fallback call (cheap tiers had hits),
      // also honour it: the tiers gave us *candidates*, the LLM is
      // the precision filter. Returning the cheap-tier order anyway
      // would defeat the filter's purpose.
    } catch (err) {
      console.warn(
        `[memory] tier 3 (LLM filter) failed for query=${JSON.stringify(query)}: ${(err as Error).message}`,
      );
      // Fail open: keep whatever the cheap tiers found rather than
      // returning nothing on a transient provider error.
      relevantIds = candidateIds;
    }

    const topK = relevantIds.slice(0, DEFAULT_RECALL_K);
    const entities = topK
      .map((id) => graph.getEntity(id))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return formatRetrievalResults(graph, entities);
  }

  async recallForInjection(query: string): Promise<string> {
    const entry = await this.getEntry();
    const graph = entry.getGraph();

    // Tiers 1+2 only for low latency (resolved decision #4).
    const orderedIds = await this.tier1And2(entry, query);

    const topK = orderedIds.slice(0, DEFAULT_RECALL_K);
    const entities = topK
      .map((id) => graph.getEntity(id))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return formatRetrievalResults(graph, entities);
  }

  /**
   * Build the forget prompt for a query against the active graph.
   * Same split-pattern as extraction (see `buildExtractionPromptFor`):
   * stdlib agency code calls this, hands it to `llm()` with a typed
   * `ForgetResult`, then calls `applyForgetFromLLM`.
   */
  async buildForgetPromptFor(query: string): Promise<string> {
    const entry = await this.getEntry();
    return forgetTemplate({
      graphIndex: entry.getGraph().toCompactIndex(),
      query,
    });
  }

  /**
   * Apply a typed forget result to the active graph. Substring match,
   * case-insensitive (resolved decision #7).
   */
  async applyForgetFromLLM(parsed: ForgetResult): Promise<void> {
    const entry = await this.getEntry();
    const graph = entry.getGraph();

    for (const exp of parsed.observations) {
      const entity = graph.findEntityByName(exp.entityName);
      if (!entity) continue;
      const obs = entity.observations.find(
        (o) =>
          o.validTo === null &&
          o.content
            .toLowerCase()
            .includes(exp.observationContent.toLowerCase()),
      );
      if (obs) {
        // Goes through the entry so the embedding entry for this
        // observation is dropped in lockstep with the graph mutation.
        entry.expireObservation(obs.id);
      }
    }

    for (const exp of parsed.relations) {
      const fromEntity = graph.findEntityByName(exp.fromName);
      const toEntity = graph.findEntityByName(exp.toName);
      if (!fromEntity || !toEntity) continue;
      const lowerType = exp.type.toLowerCase();
      const rel = graph
        .getRelations()
        .find(
          (r) =>
            r.validTo === null &&
            r.from === fromEntity.id &&
            r.to === toEntity.id &&
            r.type.toLowerCase().includes(lowerType),
        );
      if (rel) entry.expireRelation(rel.id);
    }

    await entry.persist(this.store);
  }

  /**
   * Convenience wrapper used by tests that want the whole forget
   * round-trip in one call. The agency runtime path goes through
   * `buildForgetPromptFor` + `applyForgetFromLLM` instead.
   */
  async forget(query: string): Promise<void> {
    const prompt = await this.buildForgetPromptFor(query);
    const response = await this._text(prompt, { model: this.model() });
    const parsed = parseForgetResult(response);
    if (!parsed) return;
    await this.applyForgetFromLLM(parsed);
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

    const prevSummary = entry.getSummary();
    if (prevSummary) {
      const mergePrompt = buildMergeSummaryPrompt(
        prevSummary.summary,
        newSummary,
      );
      newSummary = await this._text(mergePrompt, {
        model: this.model(),
      });
    }

    entry.setSummary({
      summary: newSummary,
      lastCompactedAt: new Date().toISOString(),
      messagesSummarized:
        (prevSummary?.messagesSummarized ?? 0) + toCompact.length,
    });

    await entry.persist(this.store);

    return {
      systemPrefixIndices,
      tailIndices,
      summaryMessageContent: `${SUMMARY_MESSAGE_PREFIX}${newSummary}`,
    };
  }

  /** Persist all cached memoryIds to disk. */
  async save(): Promise<void> {
    for (const entry of Object.values(this.cache)) {
      await entry.persist(this.store);
    }
  }

  // ---- internals ----

  private async autoExtract(
    entry: MemoryCacheEntry,
    messages: smoltalk.Message[]
  ): Promise<void> {
    const prompt = buildExtractionPrompt(messages, entry.getGraph());
    const response = await this._text(prompt, { model: this.model() });
    const result = parseExtractionResult(response);
    if (!result) return;
    const outcome = entry.applyExtraction(result, this.source);
    await this.generateEmbeddings(entry, outcome.newObservationIds);
    await entry.persist(this.store);
  }

  private async generateEmbeddings(
    entry: MemoryCacheEntry,
    observationIds: string[]
  ): Promise<void> {
    for (const obsId of observationIds) {
      const embedText = buildEmbedText(entry, obsId);
      if (!embedText) continue;
      try {
        const vector = await this._embed(embedText, {
          model: this.config.embeddings?.model,
        });
        entry.setEmbedding(obsId, vector);
      } catch {
        // Embedding failed — Tier 2 silently no-ops (resolved decision #8).
      }
    }
  }

  /**
   * Build the per-line "id: name (type) — facts" candidate index
   * fed to the Tier-3 filter prompt. Including the entity's current
   * observations lets the LLM judge relevance without us having to
   * dump the full graph; using stable ids (not names) makes the
   * response unambiguous and lets us reject hallucinated ids.
   */
  private buildCandidateIndex(
    graph: MemoryGraph,
    candidateIds: string[],
  ): string {
    const lines: string[] = [];
    for (const id of candidateIds) {
      const e = graph.getEntity(id);
      if (!e) continue;
      const facts = graph
        .getCurrentObservations(e.id)
        .map((o) => o.content)
        .join("; ");
      lines.push(
        facts
          ? `${e.id}: ${e.name} (${e.type}) — ${facts}`
          : `${e.id}: ${e.name} (${e.type})`,
      );
    }
    return lines.join("\n");
  }

  private async embeddingRecallEntityIds(
    entry: MemoryCacheEntry,
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
    const similar = entry.getEmbeddings().findSimilar(
      queryVector,
      DEFAULT_RECALL_K,
      DEFAULT_EMBEDDING_THRESHOLD
    );
    if (similar.length === 0) return [];

    // O(k) lookup via the maintained reverse index instead of O(E*O*k).
    const entityIds: string[] = [];
    for (const result of similar) {
      const entityId = entry.lookupEntityIdByObs(result.id);
      if (entityId && !entityIds.includes(entityId)) {
        entityIds.push(entityId);
      }
    }
    return entityIds;
  }

  /**
   * Tier 3: ask the LLM to pick the relevant entities from a fixed
   * candidate list (the union of Tier 1 + Tier 2 hits, or the whole
   * graph on the small-graph fallback). Returns ids in the order the
   * LLM emitted, filtered to the offered set so a hallucinated id is
   * silently dropped instead of crashing the recall.
   */
  private async llmFilterCandidates(
    entry: MemoryCacheEntry,
    query: string,
    candidateIds: string[],
    model: string,
  ): Promise<string[]> {
    if (candidateIds.length === 0) return [];
    const candidates = this.buildCandidateIndex(entry.getGraph(), candidateIds);
    const prompt = retrievalTemplate({ candidates, query });
    const response = await this._text(prompt, { model });
    const ids = parseStringArray(response);
    if (!ids) return [];
    // Hallucination guard: only keep ids we actually offered. Set
    // lookup is O(1) per check; we also de-dupe in case the LLM
    // returned the same id twice.
    const offered = new Set(candidateIds);
    const seen: Record<string, true> = Object.create(null);
    const out: string[] = [];
    for (const id of ids) {
      if (offered.has(id) && !seen[id]) {
        seen[id] = true;
        out.push(id);
      }
    }
    return out;
  }
}

// Schema for the JSON returned by the Tier-3 (LLM) filter pass — a
// list of entity ids picked from the candidate set. The manager
// additionally filters the result to ids that were actually offered
// so a hallucinated id is silently dropped.
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

export type ForgetResult = z.infer<typeof ForgetResultSchema>;

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

/**
 * Source text fed to the embedder for an observation. Synthesizes
 * "{entityName} ({entityType}): {content}" so a query that anchors
 * on the subject ("what does Maggie do?") still has cosine signal
 * against an observation as bare as "weaves baskets". The on-disk
 * Observation shape is unchanged — the structured graph remains the
 * source of truth; this contextualized string is purely the
 * embedding input.
 *
 * If the format here changes, bump `EMBEDDING_FORMAT_VERSION` in
 * types.ts so existing on-disk indexes are discarded on next load.
 *
 * Uses the cached `obsToEntity` reverse index for an O(1) entity
 * lookup instead of scanning every entity * observation.
 */
function buildEmbedText(entry: MemoryCacheEntry, obsId: string): string | null {
  const entityId = entry.lookupEntityIdByObs(obsId);
  if (!entityId) return null;
  const entity = entry.getGraph().getEntity(entityId);
  if (!entity) return null;
  const obs = entity.observations.find((o) => o.id === obsId);
  if (!obs) return null;
  return `${entity.name} (${entity.type}): ${obs.content}`;
}
