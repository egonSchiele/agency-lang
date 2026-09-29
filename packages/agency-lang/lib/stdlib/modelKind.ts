import { isDiffusersDir, modelDirEntries, readModelJson } from "./modelBackend.js";

/** What a local model takes and returns. The kind decides which server
 *  script runs it, which route serves it, and which stdlib function calls
 *  it. What a model is good for (coding, reasoning, illustration) is not a
 *  kind; that is a tag on its catalog entry. */
export type ModelKind = "chat" | "embedding" | "speech" | "image";

/** In the order `list` shows them. */
export const MODEL_KINDS: ModelKind[] = ["chat", "embedding", "speech", "image"];

export function isModelKind(value: unknown): value is ModelKind {
  return typeof value === "string" && MODEL_KINDS.includes(value as ModelKind);
}

/** The `model_type` values the speech server's family table serves. Orpheus
 *  models say `llama`, the same as a Llama chat model, so they are not
 *  listed here; the catalog names them, and the catalog wins. */
const SPEECH_MODEL_TYPES = ["qwen3_tts"];

/** What is in a model directory, read once for every rule. A missing file,
 *  or one that is not JSON, is null. */
type DirFacts = {
  names: string[];
  config: Record<string, unknown> | null;
  diffusers: boolean;
};

/** One row of the inference table: the kind, and whether the directory's
 *  files say so. Checked top to bottom; the first match wins. */
type KindRule = { kind: ModelKind; matches: (facts: DirFacts) => boolean };

function architecture(config: Record<string, unknown> | null): string {
  const architectures = config?.architectures;
  if (!Array.isArray(architectures) || typeof architectures[0] !== "string") {
    return "";
  }
  return architectures[0];
}

const KIND_RULES: KindRule[] = [
  {
    // Any diffusers pipeline is an image model. Which pipelines the image
    // server can run is its own business: it refuses a family it does not
    // serve, naming the ones it does, so this table never has to copy its
    // list.
    kind: "image",
    matches: (facts) => facts.diffusers,
  },
  {
    kind: "speech",
    matches: (facts) => SPEECH_MODEL_TYPES.includes(String(facts.config?.model_type)),
  },
  {
    kind: "chat",
    matches: (facts) => facts.names.some((name) => name.endsWith(".gguf")),
  },
  {
    kind: "chat",
    matches: (facts) => /For(CausalLM|ConditionalGeneration)$/.test(architecture(facts.config)),
  },
  {
    // An encoder whose class ends in plain `Model` (Qwen3Model, BertModel)
    // has no generation head: it returns vectors.
    kind: "embedding",
    matches: (facts) => /Model$/.test(architecture(facts.config)),
  },
];

/** What kind of model a directory holds, from its files alone, or null
 *  when no rule matches. This is the one place a kind is decided from
 *  files: `serve`, `list`, and `download` all come here. A `.gguf` file's
 *  parent directory counts as holding a chat model. */
export function kindOfModelDir(dir: string): ModelKind | null {
  const facts: DirFacts = {
    names: modelDirEntries(dir).map((entry) => entry.name),
    config: readModelJson(dir, "config.json"),
    diffusers: isDiffusersDir(dir),
  };
  return KIND_RULES.find((rule) => rule.matches(facts))?.kind ?? null;
}
