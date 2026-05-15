/**
 * Project-wide constants. Anything that's a "magic value" used in more
 * than one file (or that callers need to be able to recognize / override)
 * lives here, so the canonical value is searchable and there's only one
 * place to update.
 */

/**
 * Default OpenAI embedding model used by the memory layer when neither
 * the `memory.embeddings.model` config nor a per-call override sets one.
 * Picked because it's the cheapest current OpenAI embedding model and
 * is what `smoltalk.embed` resolves to for OpenAI-style calls.
 */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Default token threshold for triggering memory compaction when the
 * caller does not set `memory.compaction.threshold` in agency.json.
 * Compaction is expensive (LLM call) — this default keeps it from
 * firing on small/medium threads while still bounding very long ones.
 */
export const MEMORY_COMPACTION_DEFAULT_THRESHOLD = 50000;
