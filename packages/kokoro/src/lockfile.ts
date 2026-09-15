import type { HubFile, HubSnapshot } from "agency-lang/stdlib-lib/hubDownload.js";
import lockfileJson from "../models.lock.json" with { type: "json" };

export const MODEL_NAMES = ["fp32", "q8"] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

export type KokoroLockfile = {
  schemaVersion: 1;
  repo: string;
  revision: string;
  shared: HubFile[];
  models: Record<ModelName, HubFile>;
};

export const LOCKFILE = lockfileJson as KokoroLockfile;

export function isModelName(name: string): name is ModelName {
  return MODEL_NAMES.some((known) => known === name);
}

/** The files one model needs, at the pinned revision. */
export function snapshotFor(model: ModelName, lockfile: KokoroLockfile = LOCKFILE): HubSnapshot {
  return {
    repo: lockfile.repo,
    revision: lockfile.revision,
    files: [...lockfile.shared, lockfile.models[model]],
  };
}
