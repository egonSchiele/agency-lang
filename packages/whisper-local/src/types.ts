// Every entry here must have a real pinned URL + SHA-256 in
// models.lock.json. To add another upstream model, run
// `HF_COMMIT=<sha> MODELS="<name>" bash scripts/generate-lockfile.sh`,
// confirm the printed SHA against the HuggingFace UI, then add the name
// to this list and a row to README.md's Models table.
export const KNOWN_MODELS = [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v3",
  "large-v3-turbo",
] as const;

export type ModelName = (typeof KNOWN_MODELS)[number];

export type LockfileEntry = {
  url: string;
  sha256: string;
  sizeBytes: number;
};

export type Lockfile = {
  schemaVersion: 1;
  models: Record<ModelName, LockfileEntry>;
};
