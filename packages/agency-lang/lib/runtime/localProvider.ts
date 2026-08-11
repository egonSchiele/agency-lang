import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { loadLlamaCpp, type LlamaCppModule } from "smoltalk";

// Cached so we don't shell out repeatedly per process.
let cachedGlobalRoots: string[] | null = null;

/** Discover global `node_modules` roots reported by `npm` and `pnpm`, in that
 *  order. Each entry is the directory printed by `<tool> root -g` (which is
 *  itself a `node_modules` dir, e.g. `/opt/homebrew/lib/node_modules` for
 *  Homebrew npm, `~/Library/pnpm/global/5/node_modules` for pnpm). Failures
 *  (tool not installed, exit non-zero, dir missing) are silently skipped. */
export function globalNodeModulesRoots(): string[] {
  if (cachedGlobalRoots !== null) {
    return cachedGlobalRoots;
  }
  const roots: string[] = [];
  for (const cmd of ["npm", "pnpm"]) {
    try {
      const out = execFileSync(cmd, ["root", "-g"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out && fs.existsSync(out) && !roots.includes(out)) {
        roots.push(out);
      }
    } catch {
      /* tool not installed or failed — skip */
    }
  }
  cachedGlobalRoots = roots;
  return roots;
}

/** Try to resolve `smoltalk-llama-cpp` from the given global `node_modules`
 *  roots. Each `root` is itself a `node_modules` directory (the convention
 *  `npm root -g` / `pnpm root -g` uses). Node's resolver looks for
 *  `<parent>/node_modules/<pkg>` for each parent dir it walks up, so the
 *  createRequire base must live in the root's PARENT directory — from
 *  `<root>/../_resolver.js` it correctly finds `<root>/smoltalk-llama-cpp/...`.
 *  Exported for unit-testing with a controllable list of roots. */
export function resolveSmoltalkLlamaCppFromRoots(roots: string[]): string | null {
  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, "..", "_resolver.js"));
      return req.resolve("smoltalk-llama-cpp");
    } catch {
      /* not in this root — try the next */
    }
  }
  return null;
}

/** The package entry resolvable from agency's own require paths (in-workspace
 *  and user-project installs). */
function localEntry(): string | null {
  try {
    return createRequire(import.meta.url).resolve("smoltalk-llama-cpp");
  } catch {
    return null;
  }
}

/** Local require paths first, then the global npm/pnpm roots. Used by the
 *  install gate (`hasLocalModelSupport`), which only cares whether the
 *  package is reachable at all. */
export function resolveSmoltalkLlamaCppEntry(): string | null {
  return localEntry() ?? resolveSmoltalkLlamaCppFromRoots(globalNodeModulesRoots());
}

/** The chooseEntryPath decision: what to hand smoltalk, and how the package
 *  was found (for the `localModelLoaded` statelog event). `entryPath` is
 *  undefined for a bare import — sources "local" and "none". */
export type LlamaCppEntryChoice = {
  entryPath: string | undefined;
  source: "override" | "local" | "global" | "none";
};

/** What to hand smoltalk's loadLlamaCpp: an explicit entry path, or
 *  undefined for a bare import. Pure — the probes come in as values/thunks so
 *  tests pin each branch. Precedence:
 *  1. AGENCY_LLAMA_PROVIDER_MODULE (the test/advanced escape hatch; an ENTRY
 *     PATH to a plugin-shaped module — a LlamaCPP class + resolveModel),
 *     absolutized against cwd.
 *  2. Locally resolvable → undefined: smoltalk imports the bare specifier
 *     itself (under pnpm its peer instancing picks the right copy).
 *  3. A global-roots hit → that path (smoltalk cannot see global installs).
 *  4. Nothing → undefined: smoltalk's import fails with its install hint. */
export function chooseEntryPath(args: {
  override: string | undefined;
  cwd: string;
  localEntry: string | null;
  globalEntry: () => string | null;
}): LlamaCppEntryChoice {
  if (args.override !== undefined && args.override !== "") {
    const abs = path.isAbsolute(args.override)
      ? args.override
      : path.resolve(args.cwd, args.override);
    return { entryPath: abs, source: "override" };
  }
  if (args.localEntry !== null) return { entryPath: undefined, source: "local" };
  const globalPath = args.globalEntry();
  if (globalPath !== null) return { entryPath: globalPath, source: "global" };
  return { entryPath: undefined, source: "none" };
}

/** The one field of StatelogClient this module needs. Structural so the
 *  runtime bootstrap can pass its client without this file importing the
 *  statelog module. */
type LocalModelEventSink = {
  localModelLoaded(args: {
    model?: string;
    entryPath?: string;
    entrySource: string;
  }): Promise<void>;
};

/** Bootstrap hook: when the baked/overridden config routes calls to the
 *  llama-cpp provider, load it eagerly with the probe-assisted entry path.
 *  smoltalk auto-loads on text() for resolvable installs; this covers the
 *  global-CLI + global-plugin layout its bare import cannot see. Emits a
 *  `localModelLoaded` statelog event naming the pinned model and where the
 *  provider package came from. */
export async function ensureConfiguredLocalProvider(execCtx: {
  smoltalkDefaults?: { provider?: string; model?: string };
  statelogClient?: LocalModelEventSink;
}): Promise<void> {
  if (execCtx.smoltalkDefaults?.provider !== "llama-cpp") return;
  const { choice } = await loadLocalProviderDetailed();
  void execCtx.statelogClient?.localModelLoaded({
    model: execCtx.smoltalkDefaults?.model,
    entryPath: choice.entryPath,
    entrySource: choice.source,
  });
}

/** Like loadLocalProvider, also returning HOW the package was found, for
 *  callers that emit the `localModelLoaded` event. */
export async function loadLocalProviderDetailed(): Promise<{
  module: LlamaCppModule;
  choice: LlamaCppEntryChoice;
}> {
  const choice = chooseEntryPath({
    override: process.env.AGENCY_LLAMA_PROVIDER_MODULE,
    cwd: process.cwd(),
    localEntry: localEntry(),
    globalEntry: () => resolveSmoltalkLlamaCppFromRoots(globalNodeModulesRoots()),
  });
  const module = await loadLlamaCpp(
    choice.entryPath === undefined ? undefined : { entryPath: choice.entryPath },
  );
  return { module, choice };
}

/** Load smoltalk's optional llama-cpp provider, resolving the package for
 *  layouts smoltalk cannot see on its own (see chooseEntryPath). Caching,
 *  idempotency, and registration live in smoltalk's loader, not here. */
export async function loadLocalProvider(): Promise<LlamaCppModule> {
  return (await loadLocalProviderDetailed()).module;
}
