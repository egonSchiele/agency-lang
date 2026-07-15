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

// ---- Environment variables ------------------------------------------------
// Env-var names used as the wire contract between processes. Defined here (one
// place) so the writer and reader agree by construction.

/**
 * Set by `agency run --policy/--approve/--reject` on the spawned child: the
 * resolved `Policy` as JSON. Read by the runtime to install the root policy
 * handler (`installRunPolicyHandler`).
 */
export const AGENCY_RUN_POLICY = "AGENCY_RUN_POLICY";

/**
 * Set to `AGENCY_RUN_POLICY_INTERACTIVE_ON` by `agency run --interactive`.
 * When present, the root policy handler prompts on effects the policy doesn't
 * cover instead of rejecting them.
 */
export const AGENCY_RUN_POLICY_INTERACTIVE = "AGENCY_RUN_POLICY_INTERACTIVE";

/** The truthy sentinel value for `AGENCY_RUN_POLICY_INTERACTIVE`. */
export const AGENCY_RUN_POLICY_INTERACTIVE_ON = "1";

/** Env vars carrying `agency run`/`agency agent` --max-cost / --max-time to
 *  the spawned child, which installs a root guard from them. Cleared then set
 *  by the CLI, exactly like AGENCY_RUN_POLICY. Cost is dollars; time is
 *  milliseconds (the CLI parses duration strings before setting it). */
export const AGENCY_MAX_COST = "AGENCY_MAX_COST";
export const AGENCY_MAX_TIME = "AGENCY_MAX_TIME";

/** Process exit code when a top-level cost/time budget is exceeded. Distinct
 *  from 1 (generic failure) and 2 (usage error). */
export const EXIT_CODE_BUDGET_EXCEEDED = 3;
