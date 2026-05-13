// Only models with a real pinned URL + SHA-256 in models.lock.json are
// advertised here. Additional models (small, medium, large-v3, etc.) can be
// added once the lockfile entry is verified — see scripts/generate-lockfile.sh.
export const KNOWN_MODELS = [
  "tiny",
  "tiny.en",
  "base.en",
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
