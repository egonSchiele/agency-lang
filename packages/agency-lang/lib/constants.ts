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
 * Default cloud speech-to-text model. Provider is auto-resolved from the name by
 * smoltalk (whisper-1 → openai). Used when `std::speech.transcribe` sets no model.
 * The public `.agency` signature is the single owner of this default; this
 * constant exists only so callers into the runtime helper have one named value.
 */
export const DEFAULT_TRANSCRIBE_MODEL = "whisper-1";

/**
 * Default cloud text-to-speech model + voice. Provider auto-resolves from the
 * model name (tts-1 → openai). Used when `std::speech.speak` sets no model/voice.
 * As with the transcribe default, the public `.agency` signature owns these; the
 * constants just name the value in one place.
 */
export const DEFAULT_SPEECH_MODEL = "tts-1";
export const DEFAULT_SPEECH_VOICE = "alloy";

/**
 * Fixed values the DeterministicClient reports for transcribe()/speak(), so
 * tests can assert cost accrual / guard trips / byte round-trips without a real
 * provider. Mirrors DETERMINISTIC_IMAGE_COST.
 */
export const DETERMINISTIC_TRANSCRIPT = "deterministic transcript";
export const DETERMINISTIC_TRANSCRIBE_COST = 0.006;
export const DETERMINISTIC_SPEECH_COST = 0.015;

/** Recognizable fixed audio bytes ("AGENCY") the DeterministicClient returns
 *  from speak(), so a test can assert the exact bytes round-trip to the output
 *  file. */
export const DETERMINISTIC_SPEECH_BYTES: readonly number[] = [0x41, 0x47, 0x45, 0x4e, 0x43, 0x59];

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

/**
 * Set to `AGENCY_CARRIER_ON` by `agency run --wait-for-response`. When
 * present, an interrupt nobody settled is held until `agency attach` answers
 * it. The run never approves or rejects it on its own.
 */
export const AGENCY_RUN_POLICY_WAIT = "AGENCY_RUN_POLICY_WAIT";

/**
 * Set to `AGENCY_CARRIER_ON` when `spawn.interrupts.preemptivelyCreateCheckpoint`
 * is on in the config the command line read. The program then saves a held
 * question's checkpoint under `~/.agency/held/`.
 */
export const AGENCY_SAVE_HELD_CHECKPOINT = "AGENCY_SAVE_HELD_CHECKPOINT";

/** The value of a carrier that is either set or absent. */
export const AGENCY_CARRIER_ON = "1";

/** Env vars carrying `agency run`/`agency agent` --max-cost / --max-time to
 *  the spawned child, which installs a root guard from them. Cleared then set
 *  by the CLI, exactly like AGENCY_RUN_POLICY. Cost is dollars; time is
 *  milliseconds (the CLI parses duration strings before setting it). */
export const AGENCY_MAX_COST = "AGENCY_MAX_COST";
export const AGENCY_MAX_TIME = "AGENCY_MAX_TIME";

/** Resume request carried from `agency resume` to the generated child entry. */
export const AGENCY_RESUME_FILE = "AGENCY_RESUME_FILE";
export const AGENCY_RESUME_OVERRIDES = "AGENCY_RESUME_OVERRIDES";
export const AGENCY_RESUME_FORCE = "AGENCY_RESUME_FORCE";
/** The edits of `agency resume --edit`, as a JSON array. */
export const AGENCY_RESUME_EDITS = "AGENCY_RESUME_EDITS";

/** The node `agency run file.agency:node` asks the generated child entry to
 *  start. Unset means `main`. */
export const AGENCY_ENTRY_NODE = "AGENCY_ENTRY_NODE";

/** The title the program gives its process, so `ps` shows it. */
export const AGENCY_PROCESS_TITLE = "AGENCY_PROCESS_TITLE";
/** Where the seed messages are: a file's path, or `-` for standard input. */
export const AGENCY_SEED_MESSAGES = "AGENCY_SEED_MESSAGES";
/** The value of `AGENCY_SEED_MESSAGES` and of `--messages` that means
 *  standard input. */
export const SEED_FROM_STDIN = "-";
/** The path of the file a detached program's output is saved to. */
export const AGENCY_OUTPUT_FILE = "AGENCY_OUTPUT_FILE";
/** How many `spawn` calls deep this process is. Inherited on purpose: a
 *  shell job that runs `agency run --detach` counts too. */
export const AGENCY_SPAWN_DEPTH = "AGENCY_SPAWN_DEPTH";

/** The most a detached program saves of each of its two output streams. */
export const SPAWN_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
/** How long `spawn` waits for the command that starts the program. It
 *  covers the compile. */
export const SPAWN_LAUNCH_TIMEOUT_MS = 2 * 60 * 1000;
/** How much of a failed launch's error output `spawn` reports: its end. */
export const SPAWN_ERROR_TAIL_CHARS = 2_000;

/** Process exit code for a command line the program cannot act on, such as
 *  `agency run file.agency:node` naming a node the file does not have. */
export const EXIT_CODE_USAGE_ERROR = 2;

/** Process exit code when a top-level cost/time budget is exceeded. Distinct
 *  from 1 (generic failure) and 2 (usage error). */
export const EXIT_CODE_BUDGET_EXCEEDED = 3;

/**
 * The synthetic function pattern lowering emits for an object rest binder:
 * `{ a, ...rest }` becomes `__objectRest(source, ["a"])`. The TypeScript
 * builder compiles the call away, so it never reaches runtime.
 *
 * Shared because three passes have to agree on it and the typechecker runs
 * between the two that used to hold it as a literal: the lowerer emits it, the
 * builder matches it, and the undefined-function check has to know it is not a
 * user call. When only two of the three knew the name, object rest in any
 * pattern reported "Function '__objectRest' is not defined".
 */
export const OBJECT_REST_FN = "__objectRest";

/**
 * Hard cap on the bytes of a single AWS S3 object body, in both directions:
 * downloads are read up to this limit and uploads are checked against it before
 * signing. It bounds the in-memory payload, so it is a fixed safety limit, not a
 * user-tunable option. (A 10 MiB binary object is ~13.3 MiB of base64.)
 */
export const AWS_OBJECT_BYTE_LIMIT = 10 * 1024 * 1024;
