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
 * Keys are absolute paths from `MemoryFrame`'s constructor (which
 * mkdirs and resolves against `process.cwd()`); callers must NOT
 * pass raw user input here. Tests can call `_resetStoreRegistry()`
 * between cases to start clean.
 *
 * ## Interaction with the execution model
 *
 * (See https://agency-lang.com/guide/execution-model.html for the
 * runtime's deterministic-replay invariants.)
 *
 * - **Multiple agent runs in the same process sharing one `absDir`:**
 *   intentional. Both runs see the same `FileMemoryStore`, which
 *   means writes from run A are visible to run B (and vice versa)
 *   if they touch the same `memoryId`. That's the whole point of a
 *   file-backed store — memory persists across runs and is shared
 *   between concurrent agents working on the same workspace. Each
 *   run still has its own `MemoryManager` wrapping the store
 *   (per-execCtx statelog client, log level, smoltalk defaults).
 * - **Relationship to `memoryId`:** `absDir` is *where* the store
 *   lives on disk; `memoryId` (set via `setMemoryId(...)`) is
 *   *which scope* inside it — the store keeps per-id subdirectories.
 *   The two are orthogonal: one store can serve many ids, and the
 *   same id can refer to different graphs under different `absDir`s.
 *   `setMemoryId` lives on `stateStack.other.memoryId` and persists
 *   across `enableMemory` / `disableMemory` calls, so switching
 *   stores does NOT switch ids — call `setMemoryId(...)` explicitly
 *   when you want a fresh scope for a new store.
 * - **Determinism:** the store is shared *state*. Two concurrent
 *   runs that read-modify-write the same `(absDir, memoryId)` race
 *   the same way any two processes touching the same file would.
 *   Memory is intentionally outside the deterministic-replay
 *   contract — see `docs/dev/checkpointing.md` for which state IS
 *   in the contract.
 */
import { FileMemoryStore } from "./store.js";
import type { LogLevel } from "../../logger.js";

const stores: Record<string, FileMemoryStore> = {};

/**
 * Return the `FileMemoryStore` for `absDir`, creating it on first
 * call. The directory itself must already exist (callers route
 * through `MemoryFrame`'s constructor, which mkdir-p's before
 * reaching here).
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
