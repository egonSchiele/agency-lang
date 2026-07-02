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
 * Default image-generation model. Provider is auto-resolved from the name by
 * smoltalk (gpt-image-1 → openai, per smoltalk's imageModels registry), the
 * same way chat models resolve. Used when a generateImage() call sets no model.
 */
export const DEFAULT_IMAGE_MODEL = "gpt-image-1";

/**
 * Fixed USD cost the DeterministicClient reports per generated image, so tests
 * can assert cost accrual / guard trips without a real provider. Shared by the
 * deterministic client and the image-generation e2e assertion.
 */
export const DETERMINISTIC_IMAGE_COST = 0.04;

/**
 * Default token threshold for triggering memory compaction when the
 * caller does not set `memory.compaction.threshold` in agency.json.
 * Compaction is expensive (LLM call) — this default keeps it from
 * firing on small/medium threads while still bounding very long ones.
 */
export const MEMORY_COMPACTION_DEFAULT_THRESHOLD = 50000;
