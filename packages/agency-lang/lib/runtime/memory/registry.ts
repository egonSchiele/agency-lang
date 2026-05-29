/**
 * Process-wide registry of `FileMemoryStore` instances keyed by
 * absolute directory path. Stores are heavy (they own JSON file
 * caches, embedding indices, and per-id directories), so creating
 * a fresh one per execCtx that points at the same on-disk location
 * would (a) waste memory and (b) cause two parallel runs in the
 * same process to see stale writes from each other.
 *
 * Sharing by absolute dir gives us a single source of truth per
 * physical store. Per-execCtx behaviour that differs (log level,
 * statelog client, smoltalk defaults) lives on the `MemoryManager`
 * wrapping the store, not on the store itself, so it's safe to
 * share the underlying file layer.
 *
 * Keys are absolute paths from `normalizeMemoryFrame` (which mkdirs
 * and resolves against `process.cwd()`); callers must NOT pass raw
 * user input here. Tests can call `_resetStoreRegistry()` between
 * cases to start clean.
 */
import { FileMemoryStore } from "./store.js";
import type { LogLevel } from "../../logger.js";

const stores: Record<string, FileMemoryStore> = {};

/**
 * Return the `FileMemoryStore` for `absDir`, creating it on first
 * call. The directory itself must already exist (callers route
 * through `normalizeMemoryFrame`, which mkdir-p's before reaching
 * here).
 */
export function getOrCreateStore(
  absDir: string,
  logLevel?: LogLevel,
): FileMemoryStore {
  const existing = stores[absDir];
  if (existing) return existing;
  const store = new FileMemoryStore(absDir, logLevel);
  stores[absDir] = store;
  return store;
}

/** Test-only: drop all cached stores. */
export function _resetStoreRegistry(): void {
  for (const key of Object.keys(stores)) delete stores[key];
}
