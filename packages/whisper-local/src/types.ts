export type ModelName =
  | "tiny" | "tiny.en"
  | "base" | "base.en"
  | "small" | "small.en"
  | "medium" | "medium.en"
  | "large-v3" | "large-v3-turbo";

export type LockfileEntry = {
  url: string;
  sha256: string;
  sizeBytes: number;
};

export type Lockfile = {
  schemaVersion: 1;
  models: Record<ModelName, LockfileEntry>;
};
