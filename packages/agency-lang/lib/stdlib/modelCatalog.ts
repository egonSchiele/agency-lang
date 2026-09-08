import type { Backend } from "./modelBackend.js";

/** The built-in model catalog: every entry `agency local list` shows
 *  without a download, with its backend, size, and license. */

/** What a model is FOR — a single axis, orthogonal to size (size is conveyed
 *  by `params` / `sizeBytes`). Lets the CLI group + filter without parsing the
 *  description. */
export type ModelCategory =
  | "general" // general-purpose chat / instruct
  | "coding" // SWE-tuned specialists
  | "reasoning" // chain-of-thought / R1-style distills
  | "writing" // prose and fiction
  | "science" // research and science questions
  | "uncensored" // refusals removed
  | "embedding"; // returns vectors, not text

export type ModelInfo = {
  /** Which engine runs the model. Required; must agree with `uri`. */
  backend: Backend;
  /** For llama-cpp, an `hf:` URI passed to `node-llama-cpp`'s
   *  `resolveModelFile`. For mlx, an `mlx:` URI naming a Hugging Face repo. */
  uri: string;
  /** Human-readable parameter count, e.g. "1.7B" or "70B". */
  params: string;
  /** Approximate download size in bytes: the Q4_K_M file, or the whole
   *  4-bit MLX repo. */
  sizeBytes: number;
  /** What the model is for (orthogonal to size). */
  category: ModelCategory;
  /** One-line "what is it good for" — shown by `agency local alias list`. */
  description: string;
  /** Native context window in tokens. */
  contextWindow: number;
  /** License identifier (SPDX-ish). Curated entries are permissive only
   *  (apache-2.0 / mit); restrictively-licensed models (older Gemma's custom
   *  terms, llama) are intentionally excluded. Gemma 4 ships under apache-2.0,
   *  so it qualifies; Gemma 1–3 did not.
   *
   *  This must be the license the model itself DECLARES, never one inferred
   *  from its base model. Apache-2.0 is permissive, not copyleft — its §4 lets
   *  a derivative work carry different terms — so a fine-tune of an
   *  apache-2.0 base is not thereby apache-2.0. A model whose card declares no
   *  license (the Dolphin 3.0 Mistral fine-tunes, for one) does not belong
   *  here at all; add it locally with `agency local alias add` instead. */
  license: string;
  /** Pinned content SHA-256 (hex) of the resolved single-file GGUF, used to
   *  verify the download. Absent for sharded models (see issue #348). */
  sha256?: string;
};

/** Curated short-name → ModelInfo catalog. Permissive licenses only
 *  (apache-2.0 / mit). Ordered roughly by size within each grouping. */
export const CURATED_LOCAL_MODELS: Record<string, ModelInfo> = {
  // ── General ─────────────────────────────────────────────────────────────
  "smollm2-135m": {
    backend: "llama-cpp",
    uri: "hf:unsloth/SmolLM2-135M-Instruct-GGUF:Q4_K_M",
    params: "135M",
    sizeBytes: 105000000,
    category: "general",
    contextWindow: 8192,
    license: "apache-2.0",
    description:
      "Smallest practical chat model. Used by the Agency integration tests, runs anywhere.",
    sha256: "ed5fa30c487b282ec156c29062f1222e5c20875a944ac98289dbd242e947f747",
  },
  "qwen3.5-0.8b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M",
    params: "0.8B",
    sizeBytes: 500000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "Tiny model from Alibaba's current generation. Good edge-device default.",
    sha256: "bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517",
  },
  "qwen3.5-2b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
    params: "2B",
    sizeBytes: 1280000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "Most popular modern small general model. Runs on CPU comfortably.",
    sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
  },
  "qwen3.5-4b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Qwen3.5-4B-GGUF:Q4_K_M",
    params: "4B",
    sizeBytes: 2400000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "Strong multilingual small general workhorse from Alibaba.",
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
  },
  "gemma-4-e2b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/gemma-4-E2B-it-GGUF:Q4_K_M",
    params: "2B (E2B)",
    sizeBytes: 3110000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "Smallest Gemma 4 for phones and thin laptops.",
    sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
  },
  "gemma-4-e4b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/gemma-4-E4B-it-GGUF:Q4_K_M",
    params: "4B (E4B)",
    sizeBytes: 4980000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description:
      "Google's compact Gemma 4 (4.5B effective). ~5 GB, laptop-friendly multimodal model.",
    sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
  },
  "granite-4.1-8b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/granite-4.1-8b-GGUF:Q4_K_M",
    params: "8B",
    sizeBytes: 5350000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "IBM's enterprise-tuned 8B. Built for retrieval, tool use, and long documents.",
    sha256: "0f45c1af986e9900bb3b6ba46a25937e1bb80426935bc242d88c9ca90e9f5c88",
  },
  "qwen3.5-9b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
    params: "9B",
    sizeBytes: 5500000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "Modern medium general model with strong tool use.",
    sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
  },
  "gemma-4-12b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/gemma-4-12b-it-GGUF:Q4_K_M",
    params: "12B",
    sizeBytes: 7120000000,
    category: "general",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Google's mid-size Gemma 4 dense model. Strong multilingual multimodal use.",
    sha256: "0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42",
  },
  "gpt-oss-20b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/gpt-oss-20b-GGUF:Q4_K_M",
    params: "20B",
    sizeBytes: 12000000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "OpenAI's open-weights release. Balanced general model for ~16 GB machines.",
    sha256: "c27536640e410032865dc68781d80a08b98f8db5e93575919af8ccc0568aeb4f",
  },
  "mistral-small-3.1": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Mistral-Small-3.1-24B-Instruct-2503-GGUF:Q4_K_M",
    params: "24B",
    sizeBytes: 14000000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "Mistral's general 24B base model (also Devstral's foundation). Broad utility.",
    sha256: "6d670773c3908584349d41a5048d1472226b593c881fd394e8ac196c802e81e2",
  },
  "mistral-small-3.2": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF:Q4_K_M",
    params: "24B",
    sizeBytes: 14333000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description:
      "Drop-in upgrade over 3.1. Better instruction following, far fewer runaway generations.",
    sha256: "a3cc56310807ed0d145eaf9f018ccda9ae7ad8edb41ec870aa2454b0d4700b3c",
  },
  "qwen3.5-27b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Qwen3.5-27B-GGUF:Q4_K_M",
    params: "27B",
    sizeBytes: 16000000000,
    category: "general",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "Modern dense general 27B. The practical ceiling for most workstations.",
    sha256: "84b5f7f112156d63836a01a69dc3f11a6ba63b10a23b8ca7a7efaf52d5a2d806",
  },
  "gemma-4-26b-a4b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_M",
    params: "26B (A4B)",
    sizeBytes: 16900000000,
    category: "general",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Google's Gemma 4 MoE (3.8B active). Fast yet capable multimodal model.",
    sha256: "f2c28b3dc4776931ac6f879e11f203dec637ea0f14267a86ec8f6165f63f293f",
  },
  "gemma-4-31b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/gemma-4-31B-it-GGUF:Q4_K_M",
    params: "31B",
    sizeBytes: 18300000000,
    category: "general",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Largest dense Gemma 4. Top Gemma quality for high-RAM workstations.",
    sha256: "38bd64c852c4b460434cc7162fa9bdcf242faf86502581a754cb72956bb17f84",
  },
  "qwen3.5-35b-a3b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Qwen3.5-35B-A3B-GGUF:Q4_K_M",
    params: "35B (A3B)",
    sizeBytes: 22016000000,
    category: "general",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Qwen's general MoE (3B active). 27B-class quality at 9B speed, needs ~32 GB RAM.",
    sha256: "3b46d1066bc91cc2d613e3bc22ce691dd77e6f0d33c9060690d24ce6de494375",
  },
  "deepseek-r1-distill-llama-8b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/DeepSeek-R1-Distill-Llama-8B-GGUF:Q4_K_M",
    params: "8B",
    sizeBytes: 4920000000,
    category: "reasoning",
    contextWindow: 131072,
    license: "mit",
    description: "Chain-of-thought distill into Llama-8B. Best small reasoning model.",
    sha256: "0addb1339a82385bcd973186cd80d18dcc71885d45eabd899781a118d03827d9",
  },
  "deepseek-r1-0528-qwen3-8b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF:Q4_K_M",
    params: "8B",
    sizeBytes: 5030000000,
    category: "reasoning",
    contextWindow: 131072,
    license: "mit",
    description: "DeepSeek's newer R1 distill onto Qwen3-8B. Supersedes the Llama-8B distill.",
    sha256: "a86349a4180c4e6bb43f874c29c404fa2be3f90b15509bd6d86f697dba724ec1",
  },
  "phi-4-reasoning": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Phi-4-reasoning-GGUF:Q4_K_M",
    params: "14B",
    sizeBytes: 9050000000,
    category: "reasoning",
    contextWindow: 32768,
    license: "mit",
    description:
      "Microsoft's reasoning-tuned 14B. Competitive with much larger models on math/logic.",
    sha256: "960d3870b218f91116c55bf81dc313e6cdbce31b1047bb2bc8bc7ea47899b032",
  },
  "magistral-small-2509": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Magistral-Small-2509-GGUF:Q4_K_M",
    params: "24B",
    sizeBytes: 14333000000,
    category: "reasoning",
    contextWindow: 131072,
    license: "apache-2.0",
    description:
      "Mistral's reasoning model. The strongest chain-of-thought that still fits ~16 GB.",
    sha256: "6d3e5f2a83ed9d64bd3382fb03be2f6e0bc7596a9de16e107bf22f959891945b",
  },
  "devstral-small-2507": {
    backend: "llama-cpp",
    uri: "hf:mistralai/Devstral-Small-2507_gguf:Q4_K_M",
    params: "24B",
    sizeBytes: 14300000000,
    category: "coding",
    contextWindow: 131072,
    license: "apache-2.0",
    description: "Mistral's official coding-agent GGUF.",
    sha256: "1bcc2b1b7b7ea3168ba2dbe782432c464f2240598bd193930122c41b117c1796",
  },
  "devstral-small-2-24b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF:Q4_K_M",
    params: "24B",
    sizeBytes: 14334000000,
    category: "coding",
    contextWindow: 393216,
    license: "apache-2.0",
    description: "Mistral's current coding agent. Supersedes 2507 and reads 384K tokens at once.",
    sha256: "d14ba9edee1bb4c4996a726deb81e49ae81800a3216f0774634238c380aee496",
  },
  "qwen3-coder-30b-a3b": {
    backend: "llama-cpp",
    uri: "hf:unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M",
    params: "30B (A3B)",
    sizeBytes: 19000000000,
    category: "coding",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Qwen's MoE coder (3.3B active). Strong agentic coding model.",
    sha256: "fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad",
  },
  "nomic-embed-text": {
    backend: "llama-cpp",
    uri: "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:Q4_K_M",
    params: "137M",
    sizeBytes: 89000000,
    category: "embedding",
    contextWindow: 8192,
    license: "apache-2.0",
    description: "Returns 768-dim embeddings. Pair with a chat model for RAG.",
    sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
  },
  // ── MLX (whole Hugging Face repos, run through `agency local serve`) ───────
  "deepseek-v4-flash-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/DeepSeek-V4-Flash-4bit",
    params: "284B (A13B)",
    sizeBytes: 151500000000,
    category: "coding",
    contextWindow: 1048576,
    license: "mit",
    description:
      "DeepSeek's sparse coder, 79% on SWE-bench Verified. Needs about 160 GB of memory.",
  },
  "qwen3-coder-next-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/Qwen3-Coder-Next-4bit",
    params: "80B (A3B)",
    sizeBytes: 44900000000,
    category: "coding",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Qwen's agentic coder with 3B active. Fast enough to be a daily driver on 64 GB.",
  },
  "qwen3-coder-30b-a3b-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
    params: "30B (A3B)",
    sizeBytes: 17200000000,
    category: "coding",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "The MLX build of qwen3-coder-30b-a3b. Small, fast agentic coder.",
  },
  "qwen3-235b-a22b-2507-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/Qwen3-235B-A22B-Instruct-2507-4bit",
    params: "235B (A22B)",
    sizeBytes: 132300000000,
    category: "writing",
    contextWindow: 262144,
    license: "apache-2.0",
    description:
      "Top open-weight model on the EQ-Bench creative writing leaderboard. Needs about 140 GB of memory.",
  },
  "gemma-4-31b-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/gemma-4-31b-it-4bit",
    params: "31B",
    sizeBytes: 18400000000,
    category: "writing",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Google's dense 31B. The best prose writer at its size.",
  },
  "qwen3.8-27b-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/Qwen3.8-27B-4bit",
    params: "27B",
    sizeBytes: 16100000000,
    category: "science",
    contextWindow: 262144,
    license: "apache-2.0",
    description:
      "Alibaba's current 27B, 89 on GPQA Diamond. Multimodal. The research and science default.",
  },
  "gpt-oss-120b-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/gpt-oss-120b-MXFP4-Q8",
    params: "120B (A5B)",
    sizeBytes: 63400000000,
    category: "science",
    contextWindow: 131072,
    license: "apache-2.0",
    description:
      "OpenAI's open reasoning model with adjustable effort. Strong on math and science, weaker on code.",
  },
  "qwen3.6-40b-deckard-uncensored-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking-8bit",
    params: "40B",
    sizeBytes: 41500000000,
    category: "uncensored",
    contextWindow: 262144,
    license: "apache-2.0",
    description:
      "Heretic-uncensored Qwen3.6, expanded to 40B and further trained. Beats the base 27B on 6 of 7 benchmarks.",
  },
  "qwen3.8-27b-uncensored-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/Qwen3.8-27B-Uncensored-OptiQ-4bit",
    params: "27B",
    sizeBytes: 19800000000,
    category: "uncensored",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Qwen3.8-27B with refusals removed. Text-only.",
  },
  "gemma-4-31b-uncensored-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/gemma-4-31B-it-uncensored-heretic-4bit",
    params: "31B",
    sizeBytes: 17300000000,
    category: "uncensored",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "Gemma 4 31B with refusals removed by Heretic. Text-only.",
  },
  "qwen3.5-4b-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/Qwen3.5-4B-MLX-4bit",
    params: "4B",
    sizeBytes: 3060000000,
    category: "general",
    contextWindow: 262144,
    license: "apache-2.0",
    description: "The MLX build of qwen3.5-4b. Small general model for a laptop.",
  },
  "qwen3-embedding-4b-mlx": {
    backend: "mlx",
    uri: "mlx:mlx-community/Qwen3-Embedding-4B-4bit-DWQ",
    params: "4B",
    sizeBytes: 2280000000,
    category: "embedding",
    contextWindow: 40960,
    license: "apache-2.0",
    description:
      "Returns 2560-dim embeddings. mlx_lm.server has no embeddings route, so serve it with another MLX server.",
  },
};
