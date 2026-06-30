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
import type { ExtractionResult, NewObservation } from "./extraction.js";
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
import { createLogger, type Logger, type LogLevel } from "../../logger.js";
import type { StatelogClient } from "../../statelogClient.js";
import forgetTemplate from "../../templates/prompts/memory/forget.js";
import retrievalTemplate from "../../templates/prompts/memory/retrieval.js";
import type { LLMClient } from "../llmClient.js";
import { agency } from "../agency.js";
import { agencyStore } from "../asyncContext.js";
import { isGuardExceededError } from "../guard.js";

/**
 * Charge `amount` against the active branch's `withCostGuard` budget
 * if (and only if) we're inside an Agency execution frame. Memory's
 * text + embed calls run from inside `runPrompt`'s post-completion
 * hook or from stdlib agency calls — both reach this code with an
 * `agencyStore` frame already installed, so production paths always
 * charge correctly. The frame check is for direct-construction unit
 * tests that exercise `MemoryManager` without going through the
 * runner.
 */
function chargeCostIfInFrame(amount: number): void {
  if (!agencyStore.getStore()) return;
  agency.addCost(amount);
}

/**
 * Re-throw `err` if it is a `GuardExceededError` so cost / time
 * guards trip the surrounding `withCostGuard` / `withTimeGuard`
 * scope even when raised from inside one of memory's "best effort"
 * catches (tier-2 embed, tier-3 LLM filter, per-observation embed).
 * Without this, `chargeCostIfInFrame` could push the stack over the
 * limit, throw, and have its throw silently absorbed — defeating
 * the budget the user set. Provider / parse errors are not guard
 * errors and continue to fall through to the catch body as before.
 */
function rethrowIfGuard(err: unknown): void {
  if (isGuardExceededError(err)) throw err;
}

// Cap on the `inputPreview` slice we put on every embedCompletion
// event. Short enough that a transcript fragment in stderr or in a
// statelog payload doesn't accidentally leak a wall of user text;
// long enough to be diagnostically useful.
const EMBED_PREVIEW_CHARS = 200;

// Cap on the recall-query preview emitted at debug. Same intent —
// long enough to recognize, short enough not to dominate a log line.
const QUERY_PREVIEW_CHARS = 80;

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
  /** Statelog client used to emit `llmCall`/`embedding` spans and
   *  `promptCompletion`/`embedCompletion` events for memory's
   *  internal LLM/embed calls. Optional so tests can construct
   *  managers without one; production wires the per-execCtx
   *  client through `context.ts`. When absent, every statelog hook
   *  is a no-op. */
  statelogClient?: StatelogClient;
  /** Threshold for the manager's internal logger. The manager
   *  creates one logger per instance via `createLogger(logLevel)`;
   *  every line is `[memory]`-prefixed so users can grep/filter. */
  logLevel?: LogLevel;
};

const DEFAULT_RECALL_K = 10;
const DEFAULT_EMBEDDING_THRESHOLD = 0.3;

/** Default embedding model per LLM provider that smoltalk can embed with.
 *  When no embedding model is explicitly configured, Tier-2 recall derives
 *  its model from the active chat provider via this table. A provider not
 *  listed here (anthropic, llama-cpp, custom) has no embedding endpoint, so
 *  Tier-2 is disabled rather than firing a doomed remote call. */
const EMBED_MODEL_BY_PROVIDER: Record<string, string> = {
  openai: "text-embedding-3-small",
  "openai-responses": "text-embedding-3-small",
  google: "text-embedding-004",
  ollama: "nomic-embed-text",
};
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
  /** Optional — every call site uses `?.` so the absence of a
   *  statelog client (e.g. in unit tests) is a clean no-op. */
  private statelogClient?: StatelogClient;
  /** Built once in the constructor from `options.logLevel`. Each line
   *  emitted by the manager is prefixed `[memory]` so users can
   *  filter on the prefix from stderr. */
  private logger: Logger;

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
    this.statelogClient = options.statelogClient;
    // Default "info" so tests that don't pass a level don't get a
    // wall of debug output. Production reads `AgencyConfig.logLevel`
    // through `RuntimeContext.logLevel`.
    this.logger = createLogger(options.logLevel ?? "info");
  }

  /**
   * Run a single-prompt text completion through the registered
   * LLMClient. We always go through `llmClient.text` (not directly
   * to smoltalk) so a custom client registered via `setLLMClient`
   * — including the `DeterministicClient` used in tests — controls
   * memory's text calls too.
   *
   * Wrapped in an `llmCall` span + `promptCompletion` event so the
   * call shows up in the trace viewer alongside agency-driven LLM
   * calls. Errors emit a statelog `error` event before being
   * re-thrown so a failed memory call is visible even though the
   * post-turn hook in `prompt.ts` swallows it to keep the agent
   * running.
   */
  private async _text(
    prompt: string,
    options?: { model?: string; responseFormat?: z.ZodType; phase?: string },
  ): Promise<string> {
    const model = options?.model ?? this.smoltalkDefaults.model;
    const phase = options?.phase ?? "memory.text";
    const spanId = this.statelogClient?.startSpan("llmCall");
    const startTime = performance.now();
    try {
      const result = await this.llmClient.text({
        ...this.smoltalkDefaults,
        messages: [smoltalk.userMessage(prompt)],
        model,
        ...(options?.responseFormat
          ? { responseFormat: options.responseFormat }
          : {}),
      } as any);
      const timeTaken = performance.now() - startTime;
      if (!result.success) {
        this.logger.warn(
          `[memory] llm text call failed (phase=${phase}): ${result.error}`,
        );
        // Best-effort statelog notification — never let an observability
        // failure mask the real LLM error.
        try {
          // Use the generic `llmError` errorType; the phase prefix
          // ("memory.text", "remember.extract", etc.) carries the
          // memory-specific signal so a viewer can filter without
          // needing a dedicated enum value.
          await this.statelogClient?.error({
            errorType: "llmError",
            message: String(result.error),
            functionName: phase,
            retryable: false,
          });
        } catch (err) {
          this.logger.debug(
            `[memory] statelog error event failed: ${(err as Error).message}`,
          );
        }
        throw new Error(`memory llm text call failed: ${result.error}`);
      }
      try {
        await this.statelogClient?.promptCompletion({
          messages: [smoltalk.userMessage(prompt)],
          completion: result.value,
          model,
          timeTaken,
          tools: [],
          usage: result.value.usage,
          cost: result.value.cost,
          stream: false,
        });
      } catch (err) {
        this.logger.debug(
          `[memory] statelog promptCompletion failed: ${(err as Error).message}`,
        );
      }
      // Charge this call's spend against the surrounding branch's
      // cost budget. Mirrors the post-completion charge that
      // `prompt.ts` performs for agency-side `llm()` calls, so a
      // `withCostGuard($X)` wrapping the agent now sees memory's
      // extraction / compaction / tier-3 spend too.
      chargeCostIfInFrame(result.value.cost?.totalCost ?? 0);
      return result.value.output ?? "";
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
  }

  /** Same routing as _text(), but for embeddings. Returns a single
   *  vector (the LLMClient.embed protocol accepts string|string[]; we
   *  always pass one string here so the response is one vector).
   *
   *  Wrapped in an `embedding` span + `embedCompletion` event. The
   *  span type is distinct from `llmCall` so the viewer can render
   *  cost/latency for embeddings separately. */
  private async _embed(
    text: string,
    options?: { model?: string; provider?: string; phase?: string },
  ): Promise<number[]> {
    const phase = options?.phase ?? "memory.embed";
    const spanId = this.statelogClient?.startSpan("embedding");
    const startTime = performance.now();
    try {
      const result = await this.llmClient.embed(text, {
        model: options?.model,
        // Pass the provider explicitly so smoltalk routes to the right embed
        // endpoint even when the model name doesn't imply it (e.g. ollama).
        provider: options?.provider,
        apiKey: {
          openAi: (this.smoltalkDefaults as any).apiKey?.openAi,
          google: (this.smoltalkDefaults as any).apiKey?.google,
        },
        baseUrl: { ollama: (this.smoltalkDefaults as any).baseUrl?.ollama },
      } as any);
      const timeTaken = performance.now() - startTime;
      if (!result.success) {
        this.logger.warn(
          `[memory] embed call failed (phase=${phase}): ${result.error}`,
        );
        try {
          // Same rationale as `_text` above: reuse `llmError` and let
          // the phase string convey the embed-specific context.
          await this.statelogClient?.error({
            errorType: "llmError",
            message: String(result.error),
            functionName: phase,
            retryable: false,
          });
        } catch (err) {
          this.logger.debug(
            `[memory] statelog error event failed: ${(err as Error).message}`,
          );
        }
        throw new Error(`memory embed call failed: ${result.error}`);
      }
      const vector = result.value.embeddings[0];
      if (!vector) {
        this.logger.warn(
          `[memory] embed returned no vectors (phase=${phase}, model=${result.value.model ?? "?"})`,
        );
        throw new Error("memory embed returned no vectors");
      }
      try {
        await this.statelogClient?.embedCompletion({
          inputPreview: text.slice(0, EMBED_PREVIEW_CHARS),
          inputCount: 1,
          model: result.value.model ?? options?.model,
          dimensions: vector.length,
          timeTaken,
          phase,
        });
      } catch (err) {
        this.logger.debug(
          `[memory] statelog embedCompletion failed: ${(err as Error).message}`,
        );
      }
      // Same rationale as `_text` above — embed calls contribute to
      // the surrounding branch's cost budget too. `EmbedResult.costEstimate`
      // (smoltalk's name) is optional; absent / zero means "free or
      // unknown" and the charge is skipped.
      chargeCostIfInFrame(result.value.costEstimate?.totalCost ?? 0);
      return vector;
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
  }

  /** One-shot guard so the "Tier-2 disabled" notice fires once per manager,
   *  not on every recall. */
  private _embeddingDisabledLogged = false;

  /** The active LLM provider, used to derive the embedding model. Reads the
   *  active branch stack's `llmDefaults` (set by setModel/setLlmOptions — e.g.
   *  the agent's `--local-model`), falling back to the baked smoltalk defaults
   *  and finally to deriving the provider from the model name. Returns
   *  undefined when no provider can be determined. */
  private activeEmbeddingProvider(): string | undefined {
    const active = agencyStore.getStore()?.stack?.other?.llmDefaults as
      | { model?: string; provider?: string }
      | undefined;
    const baked = this.smoltalkDefaults as
      | { model?: string; provider?: string }
      | undefined;
    const provider = active?.provider || baked?.provider || undefined;
    if (provider) return provider;
    const model = active?.model || baked?.model || undefined;
    if (model) {
      // `getModel` is smoltalk's public model registry lookup; unknown models
      // (e.g. a local .gguf path) return undefined → provider undefined →
      // Tier-2 disabled, which is the intended behavior.
      try {
        return smoltalk.getModel(model)?.provider;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** Resolve the embedding model + provider to use, or null when Tier-2 should
   *  be disabled. An explicit `embeddings.model` wins; otherwise the model is
   *  derived from the active provider via `EMBED_MODEL_BY_PROVIDER`. Providers
   *  with no embedding endpoint (anthropic, llama-cpp, custom) yield null. */
  resolveEmbedding(): { model: string; provider?: string } | null {
    const explicit = this.config.embeddings?.model;
    if (explicit) {
      return { model: explicit, provider: this.config.embeddings?.provider };
    }
    const provider = this.activeEmbeddingProvider();
    if (!provider) return null;
    const model = EMBED_MODEL_BY_PROVIDER[provider];
    if (!model) return null;
    return { model, provider };
  }

  /** Embed `text`, or return null (logging once) when Tier-2 is disabled
   *  because the active provider has no embedding endpoint. Callers treat null
   *  as "skip semantic embedding for this item" — no remote call is made. */
  private async embedOrSkip(text: string, phase: string): Promise<number[] | null> {
    const target = this.resolveEmbedding();
    if (!target) {
      await this.noteEmbeddingDisabled();
      return null;
    }
    return this._embed(text, {
      model: target.model,
      provider: target.provider,
      phase,
    });
  }

  /** Emit a single notice (logger + statelog) the first time Tier-2 is
   *  disabled, so the user sees semantic recall is off (e.g. a local model
   *  with no embedding endpoint) without per-recall warn spam. */
  private async noteEmbeddingDisabled(): Promise<void> {
    if (this._embeddingDisabledLogged) return;
    this._embeddingDisabledLogged = true;
    const provider = this.activeEmbeddingProvider() ?? "unknown";
    const msg =
      `[memory] semantic recall (Tier-2) disabled: provider "${provider}" has no ` +
      `embedding endpoint. Structured recall still works; set embeddings.model to override.`;
    this.logger.info(msg);
    try {
      await this.statelogClient?.debug(msg, { provider });
    } catch (err) {
      this.logger.debug(
        `[memory] statelog notice failed: ${(err as Error).message}`,
      );
    }
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
      if (embeddingIndex) {
        // Only warn when we found an index but rejected it — a fresh
        // memoryId with no on-disk index isn't a discard, it's a
        // first-time load.
        const onDiskVersion = embeddingIndex.formatVersion ?? 1;
        this.logger.warn(
          `[memory] discarding embeddings for memoryId="${id}" (on-disk format v${onDiskVersion}, model="${embeddingIndex.model}"; current format v${EMBEDDING_FORMAT_VERSION}${configuredModel ? `, configured model="${configuredModel}"` : ""}); will rebuild on next write`,
        );
      }
      embeddings = new EmbeddingManager();
    }
    if (configuredModel) {
      embeddings.setModel(configuredModel);
    }

    const summary = await this.store.loadSummary(id);
    const entry = new MemoryCacheEntry(id, graph, embeddings, summary);
    this.cache[id] = entry;
    // One-line summary of what was loaded so users can sanity-check
    // graph sizes and embedding coverage on first use of a memoryId.
    const obsCount = graph
      .getEntities()
      .reduce((n, e) => n + e.observations.length, 0);
    this.logger.debug(
      `[memory] loaded memoryId="${id}" entities=${graph.getEntities().length} observations=${obsCount} embeddings=${embeddings.toIndex().entries.length}`,
    );
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
   *
   * Wrapped in a `memoryRemember` umbrella span so the agency-side
   * call shape (`buildExtractionPromptFor` → `llm` → `applyExtractionFromLLM`)
   * still nests its embedding work under one parent in the viewer.
   */
  async applyExtractionFromLLM(result: ExtractionResult): Promise<void> {
    const spanId = this.statelogClient?.startSpan("memoryRemember");
    // Marker event so the umbrella span materializes in the viewer.
    // The agency runtime path takes this branch (not `remember()`), so
    // without a marker the embedding writes would re-parent to the
    // trace root and the operation would be effectively invisible.
    try {
      await this.statelogClient?.memoryRemember({
        contentPreview: `apply ${result.entities.length} entities, ${result.relations.length} relations`,
        memoryId: this.getMemoryId(),
      });
    } catch (err) {
      this.logger.debug(
        `[memory] statelog memoryRemember failed: ${(err as Error).message}`,
      );
    }
    try {
      const entry = await this.getEntry();
      const outcome = entry.applyExtraction(result, this.source);
      await this.generateEmbeddings(entry, outcome.newObservations);
      await entry.persist(this.store);
      this.logger.debug(
        `[memory] applyExtraction added observations=${outcome.newObservations.length} expired=${outcome.expiredObservationIds.length}`,
      );
    } catch (err) {
      this.logger.debug(
        `[memory] applyExtractionFromLLM caught: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
  }

  /**
   * Convenience wrapper used by tests that want the whole extraction
   * round-trip in one call. The agency runtime path goes through
   * `buildExtractionPromptFor` + `applyExtractionFromLLM` instead.
   *
   * Opens its own `memoryRemember` span — the nested
   * `applyExtractionFromLLM` opens a child of the same type, which
   * is acceptable: the viewer will see two adjacent rows for the
   * same logical operation. We could short-circuit the inner call,
   * but the duplication is harmless and avoids coupling the two
   * methods through a flag.
   */
  async remember(content: string): Promise<void> {
    const spanId = this.statelogClient?.startSpan("memoryRemember");
    this.logger.debug(
      `[memory] remember content="${truncatePreview(content, QUERY_PREVIEW_CHARS)}"`,
    );
    // Marker event so the viewer materializes the umbrella span with
    // the right label and nests inner `llmCall`/`embedding` under it.
    // See StatelogClient.memoryRemember for the full reasoning.
    try {
      await this.statelogClient?.memoryRemember({
        contentPreview: truncatePreview(content, QUERY_PREVIEW_CHARS),
        memoryId: this.getMemoryId(),
      });
    } catch (err) {
      this.logger.debug(
        `[memory] statelog memoryRemember failed: ${(err as Error).message}`,
      );
    }
    try {
      const prompt = await this.buildExtractionPromptFor(content);
      const response = await this._text(prompt, {
        model: this.model(),
        phase: "remember.extract",
      });
      const result = parseExtractionResult(response);
      if (!result) {
        this.logger.debug(
          `[memory] remember: extraction parse returned null (no-op)`,
        );
        return;
      }
      await this.applyExtractionFromLLM(result);
    } catch (err) {
      this.logger.debug(
        `[memory] remember caught: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
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
    this.logger.debug(`[memory] tier1 matched ${tier1.length} entities`);

    const tier2EntityIds = await this.embeddingRecallEntityIds(entry, query);
    for (const id of tier2EntityIds) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
    this.logger.debug(
      `[memory] tier2 matched ${tier2EntityIds.length} entities (k=${DEFAULT_RECALL_K}, threshold=${DEFAULT_EMBEDDING_THRESHOLD})`,
    );

    return orderedIds;
  }

  async recall(query: string, options?: { model?: string }): Promise<string> {
    const spanId = this.statelogClient?.startSpan("memoryRecall");
    this.logger.debug(
      `[memory] recall query="${truncatePreview(query, QUERY_PREVIEW_CHARS)}"`,
    );
    try {
      await this.statelogClient?.memoryRecall({
        queryPreview: truncatePreview(query, QUERY_PREVIEW_CHARS),
        memoryId: this.getMemoryId(),
        phase: "recall",
      });
    } catch (err) {
      this.logger.debug(
        `[memory] statelog memoryRecall failed: ${(err as Error).message}`,
      );
    }
    try {
      const entry = await this.getEntry();
      const graph = entry.getGraph();
      if (graph.getEntities().length === 0) {
        this.logger.debug(`[memory] recall: empty graph, returning ""`);
        return "";
      }

      // Stage A: cheap tiers gather candidate ids.
      let candidateIds = await this.tier1And2(entry, query);

      // Stage B (fallback): if cheap tiers found nothing AND the graph
      // is small enough to fit in the prompt without blowing tokens,
      // hand the entire graph to Tier 3 as candidates. Above the limit
      // we accept "no recall" — Tiers 1+2 should have surfaced something
      // for a graph that big, and the LLM doesn't help if every entity
      // is a candidate at scale.
      let usedFallback = false;
      if (candidateIds.length === 0) {
        const all = graph.getEntities();
        if (all.length > FALLBACK_GRAPH_SIZE_LIMIT) {
          this.logger.debug(
            `[memory] recall: tiers 1+2 empty, graph size=${all.length} > ${FALLBACK_GRAPH_SIZE_LIMIT}; returning ""`,
          );
          return "";
        }
        candidateIds = all.map((e) => e.id);
        usedFallback = true;
        this.logger.debug(
          `[memory] recall: tiers 1+2 empty, falling back to whole graph (${all.length} entities)`,
        );
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
        this.logger.debug(
          `[memory] tier3 matched ${relevantIds.length} / candidates=${candidateIds.length}${usedFallback ? " (fallback)" : ""}`,
        );
        // An empty filter result on a fallback (whole-graph) call most
        // likely means the LLM correctly judged nothing relevant —
        // honour that. On a non-fallback call (cheap tiers had hits),
        // also honour it: the tiers gave us *candidates*, the LLM is
        // the precision filter. Returning the cheap-tier order anyway
        // would defeat the filter's purpose.
      } catch (err) {
        // Guard trips must bubble out of recall — they signal the
        // surrounding `withCostGuard` / `withTimeGuard` has been
        // exceeded and the agent should stop, not silently fall back.
        rethrowIfGuard(err);
        this.logger.warn(
          `[memory] tier 3 (LLM filter) failed for query="${truncatePreview(query, QUERY_PREVIEW_CHARS)}": ${(err as Error).message}`,
        );
        // Fail open: keep whatever the cheap tiers found rather than
        // returning nothing on a transient provider error.
        relevantIds = candidateIds;
      }

      const result = this.formatTopK(graph, relevantIds);
      this.logger.debug(
        `[memory] recall returned ${Math.min(relevantIds.length, DEFAULT_RECALL_K)} entities (${result.length} chars)`,
      );
      return result;
    } catch (err) {
      this.logger.debug(
        `[memory] recall caught: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
  }

  async recallForInjection(query: string): Promise<string> {
    const spanId = this.statelogClient?.startSpan("memoryRecall");
    this.logger.debug(
      `[memory] recallForInjection query="${truncatePreview(query, QUERY_PREVIEW_CHARS)}"`,
    );
    try {
      await this.statelogClient?.memoryRecall({
        queryPreview: truncatePreview(query, QUERY_PREVIEW_CHARS),
        memoryId: this.getMemoryId(),
        phase: "recallForInjection",
      });
    } catch (err) {
      this.logger.debug(
        `[memory] statelog memoryRecall failed: ${(err as Error).message}`,
      );
    }
    try {
      const entry = await this.getEntry();
      const graph = entry.getGraph();

      // Tiers 1+2 only for low latency (resolved decision #4).
      const orderedIds = await this.tier1And2(entry, query);

      const result = this.formatTopK(graph, orderedIds);
      this.logger.debug(
        `[memory] recallForInjection injecting ${Math.min(orderedIds.length, DEFAULT_RECALL_K)} facts (${result.length} chars)`,
      );
      return result;
    } catch (err) {
      this.logger.debug(
        `[memory] recallForInjection caught: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
  }

  /**
   * Slice the recall result down to `DEFAULT_RECALL_K`, resolve each
   * id to its entity (dropping ids that no longer exist), and render
   * the final user-visible string. Shared tail for `recall` (Tier
   * 1+2+3) and `recallForInjection` (Tier 1+2 only).
   */
  private formatTopK(graph: MemoryGraph, ids: string[]): string {
    const entities = ids
      .slice(0, DEFAULT_RECALL_K)
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
   *
   * Wrapped in a `memoryForget` umbrella span so the agency-side call
   * shape (`buildForgetPromptFor` → `llm` → `applyForgetFromLLM`)
   * groups its writes under one parent in the viewer.
   */
  async applyForgetFromLLM(parsed: ForgetResult): Promise<void> {
    const spanId = this.statelogClient?.startSpan("memoryForget");
    try {
      await this.statelogClient?.memoryForget({
        queryPreview: `apply ${parsed.observations.length} observations, ${parsed.relations.length} relations`,
        memoryId: this.getMemoryId(),
      });
    } catch (err) {
      this.logger.debug(
        `[memory] statelog memoryForget failed: ${(err as Error).message}`,
      );
    }
    try {
      const entry = await this.getEntry();
      const graph = entry.getGraph();
      let expiredObservations = 0;
      let expiredRelations = 0;

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
          expiredObservations++;
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
        if (rel) {
          entry.expireRelation(rel.id);
          expiredRelations++;
        }
      }

      await entry.persist(this.store);
      this.logger.debug(
        `[memory] forget expired observations=${expiredObservations} relations=${expiredRelations}`,
      );
    } catch (err) {
      this.logger.debug(
        `[memory] applyForgetFromLLM caught: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
  }

  /**
   * Convenience wrapper used by tests that want the whole forget
   * round-trip in one call. The agency runtime path goes through
   * `buildForgetPromptFor` + `applyForgetFromLLM` instead.
   */
  async forget(query: string): Promise<void> {
    const spanId = this.statelogClient?.startSpan("memoryForget");
    this.logger.debug(
      `[memory] forget query="${truncatePreview(query, QUERY_PREVIEW_CHARS)}"`,
    );
    try {
      await this.statelogClient?.memoryForget({
        queryPreview: truncatePreview(query, QUERY_PREVIEW_CHARS),
        memoryId: this.getMemoryId(),
      });
    } catch (err) {
      this.logger.debug(
        `[memory] statelog memoryForget failed: ${(err as Error).message}`,
      );
    }
    try {
      const prompt = await this.buildForgetPromptFor(query);
      const response = await this._text(prompt, {
        model: this.model(),
        phase: "forget.plan",
      });
      const parsed = parseForgetResult(response, this.logger);
      if (!parsed) {
        this.logger.debug(`[memory] forget: parse returned null (no-op)`);
        return;
      }
      await this.applyForgetFromLLM(parsed);
    } catch (err) {
      this.logger.debug(
        `[memory] forget caught: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
  }

  async onTurn(messages: smoltalk.Message[]): Promise<void> {
    try {
      const entry = await this.getEntry();
      entry.turnsSinceExtraction++;
      const interval = this.config.autoExtract?.interval ?? 5;
      if (entry.turnsSinceExtraction >= interval) {
        this.logger.debug(
          `[memory] onTurn: turn ${entry.turnsSinceExtraction}/${interval} — running autoExtract`,
        );
        await this.autoExtract(entry, messages);
        entry.turnsSinceExtraction = 0;
      }
    } catch (err) {
      this.logger.debug(
        `[memory] onTurn caught: ${(err as Error).message}`,
      );
      throw err;
    }
  }


  async compactIfNeeded(
    messages: smoltalk.Message[]
  ): Promise<CompactionPlan | null> {
    const spanId = this.statelogClient?.startSpan("memoryCompaction");
    try {
      const entry = await this.getEntry();
      const compactionConfig = {
        trigger: this.config.compaction?.trigger ?? ("token" as const),
        threshold:
          this.config.compaction?.threshold ?? MEMORY_COMPACTION_DEFAULT_THRESHOLD,
      };
      if (!shouldCompact(messages, compactionConfig)) return null;
      this.logger.debug(
        `[memory] compaction triggered (trigger=${compactionConfig.trigger}, threshold=${compactionConfig.threshold}, messages=${messages.length})`,
      );
      // Marker fires only when compaction actually runs — a no-op
      // `shouldCompact` returns early above, so we don't materialize a
      // memoryCompaction span for every turn that simply checked.
      try {
        await this.statelogClient?.memoryCompaction({
          memoryId: this.getMemoryId(),
          messageCount: messages.length,
          threshold: compactionConfig.threshold,
        });
      } catch (err) {
        this.logger.debug(
          `[memory] statelog memoryCompaction failed: ${(err as Error).message}`,
        );
      }

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
        // No clean split — warn with the message count so users can tell
        // why their thread isn't being compacted (e.g. mostly assistant
        // + tool messages with no user turns past the midpoint).
        this.logger.warn(
          `[memory] compaction skipped: no clean split point found in ${messages.length} messages (conversation=${conversation.length})`,
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
        phase: "compaction.summary",
      });

      const prevSummary = entry.getSummary();
      const merged = prevSummary !== null;
      if (prevSummary) {
        const mergePrompt = buildMergeSummaryPrompt(
          prevSummary.summary,
          newSummary,
        );
        newSummary = await this._text(mergePrompt, {
          model: this.model(),
          phase: "compaction.merge",
        });
      }

      entry.setSummary({
        summary: newSummary,
        lastCompactedAt: new Date().toISOString(),
        messagesSummarized:
          (prevSummary?.messagesSummarized ?? 0) + toCompact.length,
      });

      await entry.persist(this.store);
      this.logger.debug(
        `[memory] compaction done: toCompact=${toCompact.length} tail=${tailIndices.length} merged=${merged} summaryChars=${newSummary.length}`,
      );

      return {
        systemPrefixIndices,
        tailIndices,
        summaryMessageContent: `${SUMMARY_MESSAGE_PREFIX}${newSummary}`,
      };
    } catch (err) {
      this.logger.debug(
        `[memory] compactIfNeeded caught: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      this.statelogClient?.endSpan(spanId);
    }
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
    const response = await this._text(prompt, {
      model: this.model(),
      phase: "autoExtract",
    });
    const result = parseExtractionResult(response);
    if (!result) {
      this.logger.debug(
        `[memory] autoExtract: parse returned null (no-op)`,
      );
      return;
    }
    const outcome = entry.applyExtraction(result, this.source);
    await this.generateEmbeddings(entry, outcome.newObservations);
    await entry.persist(this.store);
    this.logger.debug(
      `[memory] autoExtract added observations=${outcome.newObservations.length} expired=${outcome.expiredObservationIds.length}`,
    );
  }

  private async generateEmbeddings(
    entry: MemoryCacheEntry,
    observations: NewObservation[]
  ): Promise<void> {
    let failures = 0;
    for (const { id } of observations) {
      const embedText = buildEmbedText(entry, id);
      if (!embedText) {
        // Should never happen: the observation was just added by
        // applyExtraction, so the entity + obs row both exist and
        // the reverse index was just updated. If we hit this, the
        // graph mutated between apply and embed in a way we don't
        // expect — make it visible instead of silently skipping.
        this.logger.warn(
          `[memory] generateEmbeddings: no embed text for obs=${id} in memoryId="${entry.memoryId}"; skipping`,
        );
        continue;
      }
      try {
        const vector = await this.embedOrSkip(embedText, "new-observation");
        // Tier-2 disabled (provider has no embedding endpoint): skip the
        // vector for this observation; structured recall still indexes it.
        if (vector === null) continue;
        entry.setEmbedding(id, vector);
      } catch (err) {
        // Guard trips bubble — see rethrowIfGuard comment.
        rethrowIfGuard(err);
        // Embedding failed — Tier 2 will silently no-op for this
        // observation (resolved decision #8). Logged at debug here so
        // a wave of failures shows up in `logLevel: "debug"` runs.
        failures++;
        this.logger.debug(
          `[memory] generateEmbeddings: embed failed for obs=${id}: ${(err as Error).message}`,
        );
      }
    }
    if (observations.length > 0) {
      this.logger.debug(
        `[memory] generateEmbeddings: ${observations.length - failures} embedded, ${failures} failed`,
      );
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
      const v = await this.embedOrSkip(query, "recall-query");
      // Tier-2 disabled (provider has no embedding endpoint): no query vector,
      // so semantic recall contributes nothing this turn.
      if (v === null) return [];
      queryVector = v;
    } catch (err) {
      // Guard trips bubble — see rethrowIfGuard comment.
      rethrowIfGuard(err);
      // Tier 2 degrades to zero hits when embedding the query fails;
      // surfaced at debug so the caller can correlate the empty tier2
      // line above with the underlying provider error.
      this.logger.debug(
        `[memory] embeddingRecallEntityIds: query embed failed: ${(err as Error).message}`,
      );
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
    // Pass the Zod schema so the provider enforces a JSON array of
    // strings at the output layer. Without this, a model that "thinks
    // out loud" or wraps the array in prose makes `parseStringArray`
    // return null and the filter silently produces no hits.
    const response = await this._text(prompt, {
      model,
      responseFormat: StringArraySchema,
      phase: "recall.tier3",
    });
    const ids = parseStringArray(response);
    if (!ids) {
      // Reaching here means the provider returned something that
      // didn't parse as a JSON string array even though we asked for
      // one via `responseFormat`. That's a real signal (bad provider
      // response, schema not honoured, etc.) and worth surfacing.
      this.logger.warn(
        `[memory] tier 3 (LLM filter) returned malformed response for query="${truncatePreview(query, QUERY_PREVIEW_CHARS)}": ${response.slice(0, 200)}`,
      );
      return [];
    }
    // Hallucination guard: only keep ids we actually offered, and
    // de-dupe in case the LLM returned the same id twice. `new
    // Set(filtered)` preserves first-seen order, which preserves the
    // LLM's ranking.
    const offered = new Set(candidateIds);
    return [...new Set(ids.filter((id) => offered.has(id)))];
  }
}

// Schema for the JSON returned by the Tier-3 (LLM) filter pass — a
// list of entity ids picked from the candidate set, wrapped in an
// object so OpenAI's structured-output API accepts it (the API
// requires the root schema to be `type: "object"` — a top-level
// array is rejected with HTTP 400). The manager additionally filters
// the result to ids that were actually offered so a hallucinated id
// is silently dropped. The retrieval prompt template (`retrieval.
// mustache`) is matched to this shape and asks the LLM to emit
// `{"ids": [...]}` rather than a bare array.
const StringArraySchema = z.object({ ids: z.array(z.string()) });

function parseStringArray(text: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = StringArraySchema.safeParse(raw);
  return result.success ? result.data.ids : null;
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

/**
 * Parse the JSON returned by the forget LLM call. Takes an optional
 * logger so the parse-failure warning is gated by the user's
 * `logLevel` — falling back to a no-op silently is fine for tests
 * that don't care about diagnostics.
 */
function parseForgetResult(
  text: string,
  logger?: Logger,
): ForgetResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    logger?.debug(
      `[memory] forget: JSON.parse failed: ${(err as Error).message}`,
    );
    return null;
  }
  const result = ForgetResultSchema.safeParse(raw);
  if (!result.success) {
    logger?.warn(
      `[memory] forget parse failed: ${result.error.message}`,
    );
    return null;
  }
  return result.data;
}

/**
 * Slice `text` to at most `max` characters, appending an ellipsis
 * marker when truncated. Used for log/event previews so long inputs
 * (e.g. embedded text, recall queries) don't dominate a line.
 */
function truncatePreview(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
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
