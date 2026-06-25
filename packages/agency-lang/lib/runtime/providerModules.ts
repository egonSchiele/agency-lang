import { pathToFileURL } from "node:url";
import path from "node:path";
import { registerProvider } from "smoltalk";

/** Absolute paths of provider modules already loaded + registered in this
 *  process. Registration writes to smoltalk's module-level registry, so a
 *  given module must be processed only once even though `loadProviderModules`
 *  runs on every fresh run, every `serve` request, and every resume. This
 *  guard is therefore load-bearing for long-running `serve` processes, not a
 *  mere optimization. */
const loadedModulePaths = new Set<string>();

/** Parse the comma-separated `AGENCY_PROVIDER_MODULES` env var. */
function envProviderModules(): string[] {
  const raw = process.env.AGENCY_PROVIDER_MODULES;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Resolve a configured path to absolute (cwd-relative when not absolute). */
function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Load every configured provider module and register its provider(s) into
 * agency's own smoltalk instance, before any user code or `llm()` call.
 *
 * A provider module is a user-authored ES module exporting
 * `register({ registerProvider })`. agency injects *its own*
 * `registerProvider` (rather than the module importing it from smoltalk) so
 * the provider lands in the registry this runtime resolves against — smoltalk
 * is a peer dependency of provider packages, and a globally-installed package
 * may otherwise carry a second smoltalk copy whose registry the runtime never
 * reads.
 *
 * Paths come from `ctx.providerModules` (baked from `agency.json`) merged with
 * `AGENCY_PROVIDER_MODULES`. Idempotent per process via `loadedModulePaths`.
 * Any failure is fatal and names the offending path — a misconfigured provider
 * module is a setup error, never silently skipped.
 */
export async function loadProviderModules(ctx: {
  providerModules?: string[];
}): Promise<void> {
  const configured = [...(ctx.providerModules ?? []), ...envProviderModules()];
  for (const raw of configured) {
    const resolved = resolvePath(raw);
    if (loadedModulePaths.has(resolved)) continue;

    // Reserve the path BEFORE the first await so concurrent calls (e.g.
    // batched `serve` requests) can't both observe it as unloaded and
    // double-register. On any failure below we un-reserve it so a later
    // call can retry instead of silently skipping a never-registered module.
    loadedModulePaths.add(resolved);
    try {
      let mod: { register?: unknown };
      try {
        // Dynamic import is required here: provider modules are optional,
        // machine-specific, and resolved at runtime, so they cannot be
        // statically imported (which would also force a dependency on the
        // provider package). The specifier is a runtime-computed file URL,
        // which additionally keeps `agency pack`'s esbuild from bundling it.
        // eslint-disable-next-line no-restricted-syntax
        mod = (await import(pathToFileURL(resolved).href)) as { register?: unknown };
      } catch (err) {
        throw new Error(
          `Failed to load provider module "${raw}" (resolved to ${resolved}): ${(err as Error).message}`,
        );
      }

      if (typeof mod.register !== "function") {
        throw new Error(
          `Provider module "${raw}" (resolved to ${resolved}) does not export a "register" function. ` +
            `Expected: export function register({ registerProvider }) { ... }`,
        );
      }

      try {
        await (mod.register as (api: {
          registerProvider: typeof registerProvider;
        }) => unknown | Promise<unknown>)({ registerProvider });
      } catch (err) {
        throw new Error(
          `Provider module "${raw}" (resolved to ${resolved}) threw during register(): ${(err as Error).message}`,
        );
      }
    } catch (err) {
      loadedModulePaths.delete(resolved);
      throw err;
    }
  }
}

/** Test-only: clear the per-process loaded-module guard. */
export function __resetLoadedProviderModules(): void {
  loadedModulePaths.clear();
}
