import { MemoryGraph } from "./graph.js";
import { EmbeddingManager } from "./embeddings.js";
import { applyExtractionResult } from "./extraction.js";
import type { ExtractionResult } from "./extraction.js";
import type {
  ConversationSummary,
  MemoryStore as MemoryStoreType,
} from "./types.js";

export type ExtractionOutcome = {
  newObservationIds: string[];
  expiredObservationIds: string[];
};

/**
 * One memoryId's worth of in-memory state — graph + embeddings index +
 * conversation summary + the obs→entity reverse index — plus the
 * mutation methods that keep all four in sync.
 *
 * Why a class (not a record): the graph, the embedding index, and the
 * obsToEntity map all have to move in lockstep. A new observation
 * needs an entry in the reverse index AND eventually an embedding
 * vector; an expired observation needs its embedding dropped and its
 * graph row marked expired. Encapsulating those updates in this class
 * means `MemoryManager` can't accidentally update one and forget
 * another. The reverse index is private; outsiders use
 * `lookupEntityIdByObs` instead of touching the map.
 *
 * Lifecycle: one instance per memoryId per `MemoryManager`. Constructed
 * from already-loaded graph + embeddings + summary by
 * `MemoryManager.getEntry`. Never shared across `MemoryManager`
 * instances. Never evicted while the manager lives.
 *
 * The class deliberately does NOT do LLM/embed calls. Embedding
 * vectors are computed by the manager (which owns the LLM client) and
 * handed back via `setEmbedding`. That keeps this class pure (no I/O
 * except `persist`) and unit-testable without mocks.
 */
export class MemoryCacheEntry {
  /**
   * Captured once at construction; every persist uses this id rather
   * than the manager's "current" id, so a concurrent `setMemoryId()`
   * during an in-flight write won't route the data to the wrong
   * memory namespace.
   */
  readonly memoryId: string;

  /**
   * Auto-extraction cadence counter, incremented per agent turn,
   * reset when extraction runs. Public field because the manager
   * orchestrates the cadence — there's no invariant for the entry
   * to enforce.
   */
  turnsSinceExtraction = 0;

  private readonly graph: MemoryGraph;
  private readonly embeddings: EmbeddingManager;
  private summary: ConversationSummary | null;

  /**
   * obs id → owning entity id. Maintained on every mutation that
   * adds or expires observations so Tier-2 embedding recall can map
   * a similarity hit back to its entity in O(1) rather than scanning
   * every entity × observation per recall.
   *
   * Null-prototype object: user-controlled observation ids cannot
   * collide with `Object.prototype` methods or pollute the prototype.
   */
  private readonly obsToEntity: Record<string, string> = Object.create(null);

  constructor(
    memoryId: string,
    graph: MemoryGraph,
    embeddings: EmbeddingManager,
    summary: ConversationSummary | null,
  ) {
    this.memoryId = memoryId;
    this.graph = graph;
    this.embeddings = embeddings;
    this.summary = summary;
    // Build the initial reverse index from whatever's already on the
    // loaded graph. After this, the index is maintained incrementally
    // by `indexNewObservations` and `expireObservation`.
    for (const e of graph.getEntities()) {
      for (const o of e.observations) {
        this.obsToEntity[o.id] = e.id;
      }
    }
  }

  getGraph(): MemoryGraph {
    return this.graph;
  }

  getEmbeddings(): EmbeddingManager {
    return this.embeddings;
  }

  getSummary(): ConversationSummary | null {
    return this.summary;
  }

  setSummary(summary: ConversationSummary | null): void {
    this.summary = summary;
  }

  /** O(1) reverse lookup. Returns undefined for unknown ids. */
  lookupEntityIdByObs(obsId: string): string | undefined {
    return this.obsToEntity[obsId];
  }

  /**
   * Apply an extraction result to the graph and maintain the
   * embedding + obsToEntity invariants in lockstep:
   *  - expired observations have their embedding entries dropped
   *  - newly-added observations get registered in the reverse index
   *
   * The caller still has to compute embedding vectors for the new
   * observations — that requires an embed-API call which is the
   * manager's responsibility, not the entry's. The returned
   * `newObservationIds` is exactly the set of ids the manager needs
   * to feed to `setEmbedding` after embedding them.
   */
  applyExtraction(result: ExtractionResult, source: string): ExtractionOutcome {
    const outcome = applyExtractionResult(this.graph, result, source);
    for (const id of outcome.expiredObservationIds) {
      this.embeddings.removeEntry(id);
    }
    this.indexNewObservations(outcome.newObservationIds);
    return outcome;
  }

  /**
   * Stash a freshly-computed embedding vector for an observation.
   * Idempotent — the underlying `EmbeddingManager.addEntry` replaces
   * any previous entry for the same obs id.
   */
  setEmbedding(obsId: string, vector: number[]): void {
    this.embeddings.addEntry(obsId, vector);
  }

  /**
   * Expire a single observation and drop its embedding entry. The
   * graph row stays (with `validTo` timestamped) so the audit trail
   * is preserved; only the embedding is purged because a similarity
   * hit on an expired observation would be misleading at recall time.
   */
  expireObservation(obsId: string): void {
    this.graph.expireObservation(obsId);
    this.embeddings.removeEntry(obsId);
  }

  /**
   * Expire a single relation. Relations have no embeddings, so this
   * is a thin pass-through; living on the entry makes the
   * "graph mutations always go through the entry" rule consistent.
   */
  expireRelation(relId: string): void {
    this.graph.expireRelation(relId);
  }

  /**
   * Save graph + embeddings + summary to the store under `memoryId`.
   * Always uses the captured id, never any "current" id from the
   * manager — same reasoning as the readonly `memoryId` field above.
   */
  async persist(store: MemoryStoreType): Promise<void> {
    await store.saveGraph(this.memoryId, this.graph.toJSON());
    await store.saveEmbeddings(this.memoryId, this.embeddings.toIndex());
    if (this.summary) {
      await store.saveSummary(this.memoryId, this.summary);
    }
  }

  /**
   * Update the cached `obsToEntity` reverse index for a set of
   * newly-added observation ids. Linear in (entities × their
   * observations) but only over the freshly-added set, so it stays
   * cheap at recall time.
   */
  private indexNewObservations(observationIds: string[]): void {
    if (observationIds.length === 0) return;
    const wanted: Record<string, true> = Object.create(null);
    for (const id of observationIds) wanted[id] = true;
    for (const e of this.graph.getEntities()) {
      for (const o of e.observations) {
        if (wanted[o.id]) this.obsToEntity[o.id] = e.id;
      }
    }
  }
}
