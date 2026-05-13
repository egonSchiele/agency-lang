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
