# Local-Model Management + `--local-model` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a suite of composable local-model tools — `stdlib/agency/local.agency` functions, an `agency local` CLI, a general `std::llm registerProviderModule`, runtime-read `client.modelAliases`, and an agent `--local-model` flag — all backed by one TS module.

**Architecture:** All logic lives in `lib/stdlib/localModels.ts` (the source of truth), exposed as agency functions (`stdlib/agency/local.agency`) and called by the CLI (`lib/cli/local.ts`). Downloads use `node-llama-cpp`'s `resolveModelFile` via a bundled, load-on-demand `llama-cpp.mjs` provider module, so `smoltalk-llama-cpp` stays a non-dependency.

**Tech Stack:** TypeScript (ESM), smoltalk / smoltalk-llama-cpp / node-llama-cpp, commander, vitest, the agency-js harness.

**Spec:** `docs/superpowers/specs/2026-06-25-local-model-flag-design.md`

---

## Setup (do once)

In the `local-model-flag` worktree (branch `local-model-flag`), package dir `packages/agency-lang`.

- [ ] **Install + full build baseline**

```bash
pnpm install
make
```
Expected: succeed.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `lib/stdlib/providers/llamaModelConfig.ts` (+test) | Pure `splitModelPath`. | Create |
| `lib/stdlib/providers/llama-cpp.mjs` | Bundled provider module (`register` + `resolveModel`). | Create |
| `Makefile` | Copy `lib/stdlib/providers/*.mjs` to `dist/`. | Modify |
| `lib/config.ts` (+test) | `client.modelAliases` type + zod. | Modify |
| `lib/runtime/providerModules.ts` | Extract `loadProviderModuleByPath` (shared single-module loader). | Modify |
| `lib/importPaths.ts` (+test) | Extract generic `findFileUp` from `findPackageRoot`; reuse in both. | Modify |
| `lib/stdlib/llm.ts` (+test) | `_registerProviderModule(path)` general runtime register. | Modify |
| `lib/stdlib/localModels.ts` (+tests) | Catalog, name/alias resolution, list/download/remove, register*. | Create |
| `stdlib/agency/local.agency` | Agency wrappers. | Create |
| `stdlib/llm.agency` | `registerProviderModule` wrapper. | Modify |
| `lib/cli/local.ts` (+test) | `agency local` action handlers. | Create |
| `scripts/agency.ts` | Wire the `agency local` command tree. | Modify |
| `lib/agents/agency-agent/agent.agency` + `shared.agency` | `--local-model` + `configureLocalModel`. | Modify |
| `tests/agency-js/local-model/` | e2e against a fake bundled module. | Create |
| `docs/site/guide/custom-providers.md` | Easy button + `agency local` docs. | Modify |
| `docs/site/cli/local.md` | `agency local` CLI reference page (matches pack/agent/etc.). | Create |
| `tests/integration/local-model/*.test.ts` | Real-download + real-inference tests, gated on `AGENCY_LLM_INTEGRATION=1`. | Create |
| `.github/workflows/local-model.yml` | Post-merge CI: installs pinned `smoltalk-llama-cpp` and runs the integration suite on push to `main`. | Create |
| `docs/dev/local-model-integration.md` | How to run the integration suite locally. | Create |

Style checklist applied to every code block in this plan (per `docs/dev/anti-patterns.md`):
- No empty `catch { }` blocks; JSON parse errors are surfaced with the file path.
- All `if` statements use `{ ... }` blocks; no `if (cond) doX();` one-liners.
- Magic numbers are named (`BYTES_PER_GB`, `MAX_*`, …); shared formatters extracted (`formatGB`).
- Config edits use spread (`{ ...cfg, client: { ...cfg.client, ... } }`) instead of in-place mutation.
- Imperative for-loops are replaced with `.map`/`.filter`/`.reduce` where the result is a value, not an effect.
- Walk-up file lookups reuse the new `findFileUp` helper in `lib/importPaths.ts` (Task 2.5) — no duplicated loops.

Shared conventions used throughout:
- **Cache dir**: `process.env.AGENCY_MODELS_DIR` else `~/.agency-agent/models`. TS functions that take a `cacheDir` parameter treat **empty string** as "use the default" (so agency wrappers can pass `cacheDir` straight through without importing a helper for the default).
- **Alias config file**: walk up from `process.cwd()` looking for `agency.json`; if none is found, fall back to `~/agency.json`. The exact resolved path is part of the public contract — CLI/agency wrappers print it on every write so users always know which file they edited.
- **Bundled module path**: `process.env.AGENCY_LLAMA_PROVIDER_MODULE` (tests/advanced) else the **absolute filesystem path** of `./providers/llama-cpp.mjs` relative to `localModels.ts` — computed once via `fileURLToPath(new URL("./providers/llama-cpp.mjs", import.meta.url))`. Returning an fs path (not a `file://` URL) is required because `loadProviderModuleByPath` runs its input through `path.isAbsolute` / `path.resolve(cwd, ...)`, which would mangle a URL string. When `AGENCY_LLAMA_PROVIDER_MODULE` is set, `requireSupport()` does NOT gate on `smoltalk-llama-cpp` resolving (the caller has explicitly supplied a provider module). This env-var-disables-the-install-gate behavior is documented in the spec.

---

### Task 1: Pure `splitModelPath`

**Files:** Create `lib/stdlib/providers/llamaModelConfig.ts` + `.test.ts`

- [ ] **Step 1: Failing test** — `lib/stdlib/providers/llamaModelConfig.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { splitModelPath } from "./llamaModelConfig.js";

describe("splitModelPath", () => {
  it("splits an absolute gguf path", () => {
    expect(splitModelPath("/home/u/models/qwen.gguf")).toEqual({
      model: "qwen.gguf",
      llamaCppModelDir: "/home/u/models",
    });
  });
  it("handles a bare filename", () => {
    expect(splitModelPath("qwen.gguf")).toEqual({ model: "qwen.gguf", llamaCppModelDir: "." });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test:run lib/stdlib/providers/llamaModelConfig.test.ts 2>&1 | tee /tmp/t1.txt` (module missing).

- [ ] **Step 3: Implement** — `lib/stdlib/providers/llamaModelConfig.ts`:
```ts
import path from "node:path";

/** Split a resolved `.gguf` path into the `{ model, llamaCppModelDir }` shape
 *  `smoltalk-llama-cpp`'s `LlamaCPP` expects. Pure + dependency-free so it is
 *  unit-testable without the optional package installed. */
export function splitModelPath(ggufPath: string): { model: string; llamaCppModelDir: string } {
  return { model: path.basename(ggufPath), llamaCppModelDir: path.dirname(ggufPath) };
}
```

- [ ] **Step 4: Run, expect PASS** — same command.

- [ ] **Step 5: Commit**
```bash
git add lib/stdlib/providers/llamaModelConfig.ts lib/stdlib/providers/llamaModelConfig.test.ts
git commit -m "feat(local-model): pure splitModelPath helper"
```

---

### Task 2: Config `client.modelAliases`

**Files:** Modify `lib/config.ts`; Create `lib/config.modelAliases.test.ts`

- [ ] **Step 1: Failing test** — `lib/config.modelAliases.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AgencyConfigSchema } from "./config.js";

describe("config client.modelAliases", () => {
  it("accepts a record of name -> uri", () => {
    const parsed = AgencyConfigSchema.parse({ client: { modelAliases: { my7b: "hf:org/repo:Q4_K_M" } } });
    expect(parsed.client?.modelAliases).toEqual({ my7b: "hf:org/repo:Q4_K_M" });
  });
  it("rejects a non-string value", () => {
    expect(() => AgencyConfigSchema.parse({ client: { modelAliases: { x: 5 } } })).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test:run lib/config.modelAliases.test.ts 2>&1 | tee /tmp/t2.txt`.

- [ ] **Step 3: Add the type field** — in `lib/config.ts`, inside `client?: Partial<{ ... }>` (after the `providerModules: string[];` field added in PR #340):
```ts
    /** Short name → Hugging Face URI aliases for local models, used by
     *  `std::agency/local` and the `agency local` CLI. Read and written at
     *  runtime (not compile-time baked) so `agency local alias` edits take
     *  effect on the next run. */
    modelAliases: Record<string, string>;
```

- [ ] **Step 4: Add the zod field** — in the `client` `z.object({...})` (after `providerModules: z.array(z.string()),`):
```ts
        modelAliases: z.record(z.string(), z.string()),
```

- [ ] **Step 5: Run, expect PASS** — same command.

- [ ] **Step 6: Commit**
```bash
git add lib/config.ts lib/config.modelAliases.test.ts
git commit -m "feat(config): add client.modelAliases"
```

---

### Task 2.5: Extract generic `findFileUp` from `findPackageRoot`

**Files:** Modify `lib/importPaths.ts`; Modify `lib/importPaths.test.ts` (or create if missing)

`findPackageRoot` already implements a walk-up search; the alias-config resolver (Task 3) needs the same shape for `agency.json`. Extract the shared "walk up looking for a file" loop so we don't duplicate it (anti-patterns §"Duplicating existing code") and make `findPackageRoot` delegate to it.

- [ ] **Step 1: Failing test** — add to `lib/importPaths.test.ts` (or create the file):
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findFileUp } from "./importPaths.js";

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fu-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("findFileUp", () => {
  it("returns the path of the nearest matching file, walking up", () => {
    const nested = path.join(dir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    const marker = path.join(dir, "agency.json");
    fs.writeFileSync(marker, "{}");
    expect(findFileUp(nested, "agency.json")).toBe(marker);
  });
  it("accepts a predicate so callers can match more than 'file exists'", () => {
    const nested = path.join(dir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "wrong" }));
    fs.writeFileSync(path.join(nested, "package.json"), JSON.stringify({ name: "right" }));
    const found = findFileUp(nested, "package.json", (p) => {
      try { return JSON.parse(fs.readFileSync(p, "utf-8")).name === "right"; }
      catch { return false; }
    });
    expect(found).toBe(path.join(nested, "package.json"));
  });
  it("returns null when nothing matches", () => {
    // An isolated tmp tree with no agency.json anywhere on the way up.
    expect(findFileUp(dir, "definitely-not-a-real-file.xyz")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test:run lib/importPaths.test.ts 2>&1 | tee /tmp/t2_5.txt`.

- [ ] **Step 3: Implement** — add to `lib/importPaths.ts`, then refactor `findPackageRoot` to delegate:
```ts
/** Walk up from `startDir` looking for a sibling file named `filename`.
 *  Returns the absolute path of the first match, or `null` if no match is
 *  found before reaching the filesystem root. An optional `accept` predicate
 *  lets callers reject false-positive matches (e.g. a `package.json` with the
 *  wrong `name` field) and keep walking. */
export function findFileUp(
  startDir: string,
  filename: string,
  accept: (absPath: string) => boolean = () => true,
): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate) && accept(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
```
Then make `findPackageRoot` delegate (preserves the existing behavior + error messages exactly):
```ts
export function findPackageRoot(
  startDir: string,
  packageName?: string,
): string {
  const found = findFileUp(startDir, "package.json", (pkgJsonPath) => {
    if (packageName === undefined) {
      return true;
    }
    try {
      return JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")).name === packageName;
    } catch {
      /* unparseable package.json — keep walking */
      return false;
    }
  });
  if (found === null) {
    throw new Error(
      packageName
        ? `Could not find package root for '${packageName}' (no matching package.json found above ${startDir})`
        : "Could not find package root (no package.json found)",
    );
  }
  return path.dirname(found);
}
```

- [ ] **Step 4: Run, expect PASS** — re-run the new test AND the existing importPaths tests to confirm the refactor is behavior-preserving:
```bash
pnpm test:run lib/importPaths.test.ts 2>&1 | tee /tmp/t2_5.txt
```

- [ ] **Step 5: Commit**
```bash
git add lib/importPaths.ts lib/importPaths.test.ts
git commit -m "refactor(importPaths): extract findFileUp helper"
```

---

### Task 3: `localModels.ts` — catalog, names, aliases, list, remove

These functions need no `smoltalk-llama-cpp`, so they are fully unit-testable.

**Files:** Create `lib/stdlib/localModels.ts` + `lib/stdlib/localModels.test.ts`

- [ ] **Step 1: Failing test** — `lib/stdlib/localModels.test.ts`. Note: the alias functions accept an explicit `file` parameter so tests don't need to `process.chdir` (which is racy under vitest's parallel runner); `resolveAliasConfigPath` is exported and unit-tested separately for the walk-up behavior:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CURATED_LOCAL_MODELS,
  _resolveModelName,
  _listModelNames,
  _aliasModel,
  _unaliasModel,
  _listDownloadedModels,
  _removeModel,
  _localModelsSupported,
  resolveAliasConfigPath,
} from "./localModels.js";

let dir: string;
let aliasFile: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lm-")));
  aliasFile = path.join(dir, "agency.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("name resolution", () => {
  it("passes paths and uris through", () => {
    expect(_resolveModelName("/x/y.gguf", aliasFile)).toBe("/x/y.gguf");
    expect(_resolveModelName("hf:org/repo:Q4", aliasFile)).toBe("hf:org/repo:Q4");
  });
  it("maps a curated short name to its uri", () => {
    const k = Object.keys(CURATED_LOCAL_MODELS)[0];
    expect(_resolveModelName(k, aliasFile)).toBe(CURATED_LOCAL_MODELS[k].uri);
  });
  it("throws listing known names for an unknown one", () => {
    expect(() => _resolveModelName("nope", aliasFile)).toThrow(/Unknown local model "nope"/);
  });
  it("user alias overrides a curated short name with the same key", () => {
    fs.writeFileSync(aliasFile, "{}");
    const curatedKey = Object.keys(CURATED_LOCAL_MODELS)[0];
    _aliasModel(curatedKey, "hf:custom/override:Q4", aliasFile);
    expect(_resolveModelName(curatedKey, aliasFile)).toBe("hf:custom/override:Q4");
  });
});

describe("curated catalog shape", () => {
  it("every entry has a non-empty uri, params, description, and a known category", () => {
    const validCategories = new Set([
      "tiny", "small", "medium", "large", "xl", "coding", "reasoning", "embedding",
    ]);
    for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
      expect(info.uri, `${name}.uri`).toMatch(/^hf:/);
      expect(info.params.length, `${name}.params`).toBeGreaterThan(0);
      expect(info.description.length, `${name}.description`).toBeGreaterThan(0);
      expect(info.sizeBytes, `${name}.sizeBytes`).toBeGreaterThan(0);
      expect(info.contextWindow, `${name}.contextWindow`).toBeGreaterThan(0);
      expect(validCategories.has(info.category), `${name}.category=${info.category}`).toBe(true);
    }
  });
  it("smollm2-135m is present (integration suite depends on it)", () => {
    expect(CURATED_LOCAL_MODELS["smollm2-135m"]).toBeDefined();
    expect(CURATED_LOCAL_MODELS["smollm2-135m"].category).toBe("tiny");
  });
});

describe("aliases", () => {
  it("add → resolve → list → remove round-trips via the provided file", () => {
    fs.writeFileSync(aliasFile, "{}"); // empty project config; ensures we don't touch ~/agency.json
    const file = _aliasModel("my7b", "hf:org/repo:Q4_K_M", aliasFile);
    expect(file).toBe(aliasFile);
    expect(_resolveModelName("my7b", aliasFile)).toBe("hf:org/repo:Q4_K_M");
    expect(_listModelNames(aliasFile)).toContainEqual({ name: "my7b", target: "hf:org/repo:Q4_K_M", source: "alias" });
    _unaliasModel("my7b", aliasFile);
    expect(() => _resolveModelName("my7b", aliasFile)).toThrow();
  });
  it("preserves other config fields when writing", () => {
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { defaultModel: "gpt-4o-mini" } }));
    _aliasModel("a", "hf:x/y:Q4", aliasFile);
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf-8"));
    expect(cfg.client.defaultModel).toBe("gpt-4o-mini");
    expect(cfg.client.modelAliases.a).toBe("hf:x/y:Q4");
  });
  it("unaliasModel bails early when the file or alias is missing (no write)", () => {
    // file absent: no-op
    _unaliasModel("ghost", aliasFile);
    expect(fs.existsSync(aliasFile)).toBe(false);
    // file present but alias absent: file unchanged
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { defaultModel: "x" } }, null, 2));
    const before = fs.readFileSync(aliasFile, "utf-8");
    _unaliasModel("ghost", aliasFile);
    expect(fs.readFileSync(aliasFile, "utf-8")).toBe(before);
  });
});

describe("resolveAliasConfigPath", () => {
  it("walks up from the start dir to find agency.json", () => {
    const nested = path.join(dir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(aliasFile, "{}");
    expect(resolveAliasConfigPath(nested)).toBe(aliasFile);
  });
  it("falls back to ~/agency.json when none is found", () => {
    // start in an isolated tmp tree with no agency.json on the way up to /
    // Skip if the tmp tree itself happens to contain one (unlikely on CI).
    const isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lm-iso-")));
    try {
      expect(resolveAliasConfigPath(isolated)).toBe(path.join(os.homedir(), "agency.json"));
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("downloaded models", () => {
  it("lists and removes .gguf files in the cache dir", () => {
    const cache = path.join(dir, "models");
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, "a.gguf"), "xxxx");
    const listed = _listDownloadedModels(cache);
    expect(listed.map((m) => m.name)).toEqual(["a.gguf"]);
    expect(listed[0].sizeBytes).toBe(4);
    expect(_removeModel("a.gguf", cache)).toBe(true);
    expect(_listDownloadedModels(cache)).toEqual([]);
    expect(_removeModel("missing.gguf", cache)).toBe(false);
  });
  it("returns [] for a missing cache dir", () => {
    expect(_listDownloadedModels(path.join(dir, "nope"))).toEqual([]);
  });
  it("treats empty-string cacheDir as 'use default'", () => {
    // Just assert it doesn't throw and returns an array (default dir may be empty/missing).
    expect(Array.isArray(_listDownloadedModels(""))).toBe(true);
  });
});

describe("support check", () => {
  it("is false when smoltalk-llama-cpp is not installed", () => {
    expect(_localModelsSupported()).toBe(false); // not installed in the test env
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test:run lib/stdlib/localModels.test.ts 2>&1 | tee /tmp/t3.txt`.

- [ ] **Step 3: Implement** — `lib/stdlib/localModels.ts`. Notes on the public shape:
  - Every TS function that takes `cacheDir` or `file` accepts `""` (empty string) to mean "use the default" — agency wrappers pass the user's argument through verbatim and don't need to import a helper.
  - `resolveAliasConfigPath` is exported (not `_`-prefixed) because the CLI also uses it to print which file is being edited.
  - `_aliasModel`/`_unaliasModel` return the resolved file path so callers can show the user exactly what was written. `_unaliasModel` bails early if the file or the alias is missing (no spurious write).

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { findFileUp } from "../importPaths.js";

/** Categories let the CLI / future tooling group + filter without inspecting
 *  the description. Kept as a small string union so the set is self-documenting. */
export type ModelCategory =
  | "tiny"        // < 1 GB, sub-1B parameters; smoke tests, edge devices
  | "small"       // 1–3 GB, 1–3B parameters; cheap on-CPU general use
  | "medium"      // 4–6 GB, 7–9B parameters; the modern "sweet spot"
  | "large"       // 8–20 GB, 12–32B parameters; needs >=16 GB RAM or a GPU
  | "xl"          // > 20 GB, 70B+; needs a serious workstation
  | "coding"      // SWE-tuned specialists (any size)
  | "reasoning"   // R1-style chain-of-thought distills (any size)
  | "embedding";  // BERT-family; returns vectors, not text

export type ModelInfo = {
  /** Hugging Face URI passed to `node-llama-cpp`'s `resolveModelFile`. */
  uri: string;
  /** Human-readable parameter count, e.g. "1.7B" or "70B". */
  params: string;
  /** Approximate Q4_K_M download size in bytes. */
  sizeBytes: number;
  /** Bucket for filtering / display. */
  category: ModelCategory;
  /** One-line "what is it good for" — shown by `agency local alias list`. */
  description: string;
  /** Native context window in tokens. */
  contextWindow: number;
  /** License identifier (SPDX-ish): "apache-2.0", "llama3.1", "gemma", "mit", etc. */
  license: string;
};

/** Curated short-name → ModelInfo catalog. Covers tiny → XL across 7 providers
 *  with the **current** (mid-2026) generation of each family, plus coding /
 *  reasoning / embedding specialists. The unknown-name error lists these so
 *  the set is self-documenting. Sizes are Q4_K_M; bump entries when the
 *  upstream repo's recommended quant filename changes.
 *
 *  IMPORTANT — the maintainer MUST verify every entry on Hugging Face before
 *  merging. Repo paths for community GGUF quants (unsloth/, bartowski/) are
 *  extrapolated from each family's naming convention and may not exist for
 *  every size; substitute the actual published repo before shipping. The unit
 *  test in Task 3 asserts the *shape* of each entry, not that the URI resolves.
 *
 *  Editorial principles:
 *  - One canonical entry per family/size — don't ship every minor revision.
 *  - Prefer the model author's own GGUF repo when they ship one (Mistral,
 *    Nomic); otherwise prefer `unsloth/` or `bartowski/` (the two community
 *    quant repos with the most reliable imatrix-based Q4_K_M files).
 *  - `smollm2-135m` is the integration-suite fixture (Task 12) AND a useful
 *    "smallest working model" for quick smoke tests; keep it pinned to a
 *    specific revision (Task 12 EXPECTED_SHA256). */
export const CURATED_LOCAL_MODELS: Record<string, ModelInfo> = {
  // ── Tiny (sub-1GB) ──────────────────────────────────────────────────────
  "smollm2-135m": {
    uri: "hf:HuggingFaceTB/SmolLM2-135M-Instruct-GGUF:Q4_K_M",
    params: "135M", sizeBytes: 88_000_000, category: "tiny",
    contextWindow: 8192, license: "apache-2.0",
    description: "Smallest practical chat model; used by our integration tests, runs anywhere.",
  },
  "qwen3.5-0.8b": {
    uri: "hf:unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M",
    params: "0.8B", sizeBytes: 500_000_000, category: "tiny",
    contextWindow: 131072, license: "apache-2.0",
    description: "Tiny model from Alibaba's current generation; good edge-device default.",
  },

  // ── Small (1–3GB) ───────────────────────────────────────────────────────
  "qwen3.5-2b": {
    uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
    params: "2B", sizeBytes: 1_280_000_000, category: "small",
    contextWindow: 131072, license: "apache-2.0",
    description: "Most popular modern small general model; runs on CPU comfortably.",
  },
  "gemma-3-4b": {
    uri: "hf:unsloth/gemma-3-4b-it-GGUF:Q4_K_M",
    params: "4B", sizeBytes: 2_500_000_000, category: "small",
    contextWindow: 131072, license: "gemma",
    description: "Google's small multimodal model (text + image input); 128K context.",
  },
  "qwen3.5-4b": {
    uri: "hf:unsloth/Qwen3.5-4B-GGUF:Q4_K_M",
    params: "4B", sizeBytes: 2_400_000_000, category: "small",
    contextWindow: 131072, license: "apache-2.0",
    description: "Strong multilingual small general workhorse from Alibaba.",
  },

  // ── Medium (3–7GB) ──────────────────────────────────────────────────────
  "deepseek-r1-distill-llama-8b": {
    uri: "hf:unsloth/DeepSeek-R1-Distill-Llama-8B-GGUF:Q4_K_M",
    params: "8B", sizeBytes: 4_920_000_000, category: "reasoning",
    contextWindow: 131072, license: "mit",
    description: "Chain-of-thought distill into Llama-8B; best small reasoning model.",
  },
  "qwen3.5-9b": {
    uri: "hf:unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
    params: "9B", sizeBytes: 5_500_000_000, category: "medium",
    contextWindow: 131072, license: "apache-2.0",
    description: "Modern medium general model with strong tool use; 128K context.",
  },

  // ── Large (8–25GB) ──────────────────────────────────────────────────────
  "phi-4-reasoning": {
    uri: "hf:bartowski/Phi-4-reasoning-GGUF:Q4_K_M",
    params: "14B", sizeBytes: 9_050_000_000, category: "reasoning",
    contextWindow: 32768, license: "mit",
    description: "Microsoft's reasoning-tuned 14B; competitive with much larger models on math/logic.",
  },
  "gpt-oss-20b": {
    uri: "hf:unsloth/gpt-oss-20b-GGUF:Q4_K_M",
    params: "20B", sizeBytes: 12_000_000_000, category: "large",
    contextWindow: 131072, license: "apache-2.0",
    description: "OpenAI's open-weights release; balanced general model for ~16 GB machines.",
  },
  "devstral-small-2507": {
    uri: "hf:mistralai/Devstral-Small-2507_gguf:Q4_K_M",
    params: "24B", sizeBytes: 14_300_000_000, category: "coding",
    contextWindow: 131072, license: "apache-2.0",
    description: "Mistral's official coding-agent GGUF; #1 open-source on SWE-Bench at release.",
  },
  "mistral-small-3.1": {
    uri: "hf:unsloth/Mistral-Small-3.1-24B-Instruct-2503-GGUF:Q4_K_M",
    params: "24B", sizeBytes: 14_000_000_000, category: "large",
    contextWindow: 131072, license: "apache-2.0",
    description: "Mistral's general 24B base model (also Devstral's foundation); broad utility.",
  },
  "gemma-4-26b-a4b": {
    uri: "hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_M",
    params: "26B (A4B)", sizeBytes: 16_000_000_000, category: "large",
    contextWindow: 131072, license: "gemma",
    description: "Google's MoE Gemma 4 with only 3.8B active params; local sweet spot for 24GB+ machines.",
  },
  "qwen3-coder-30b-a3b": {
    uri: "hf:unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M",
    params: "30B (A3B)", sizeBytes: 19_000_000_000, category: "coding",
    contextWindow: 262144, license: "apache-2.0",
    description: "Qwen's MoE coder (3.3B active); strong agentic coding + 256K context.",
  },
  "qwen3.5-27b": {
    uri: "hf:unsloth/Qwen3.5-27B-GGUF:Q4_K_M",
    params: "27B", sizeBytes: 16_000_000_000, category: "large",
    contextWindow: 131072, license: "apache-2.0",
    description: "Modern dense general 27B; the practical ceiling for most workstations.",
  },

  // ── XL (25GB+) ──────────────────────────────────────────────────────────
  "llama-4-scout": {
    uri: "hf:unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF:Q4_K_M",
    params: "109B (A17B)", sizeBytes: 65_000_000_000, category: "xl",
    contextWindow: 10_000_000,  // yes, 10M tokens
    license: "llama4",
    description: "Meta's long-context MoE (17B active); 10M-token context for whole-repo / huge-doc work.",
  },

  // ── Embedding ───────────────────────────────────────────────────────────
  "nomic-embed-text": {
    uri: "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:Q4_K_M",
    params: "137M", sizeBytes: 89_000_000, category: "embedding",
    contextWindow: 8192, license: "apache-2.0",
    description: "Returns 768-dim embeddings; pair with a chat model for RAG.",
  },
};

export function defaultCacheDir(): string {
  return process.env.AGENCY_MODELS_DIR ?? path.join(os.homedir(), ".agency-agent", "models");
}

/** Treat empty string as "caller wants the default cache dir". */
function resolveCacheDir(cacheDir: string): string {
  return cacheDir === "" ? defaultCacheDir() : cacheDir;
}

function isGgufPath(v: string): boolean {
  return v.endsWith(".gguf");
}

function isModelUri(v: string): boolean {
  return /^(hf:|https?:)/.test(v);
}

/** The agency.json that owns aliases: nearest `agency.json` walking up from
 *  `startDir` (cwd by default); falls back to `~/agency.json` when none is
 *  found. Exported so the CLI can echo it on every write. */
export function resolveAliasConfigPath(startDir: string = process.cwd()): string {
  return findFileUp(startDir, "agency.json") ?? path.join(os.homedir(), "agency.json");
}

/** Treat empty string as "caller wants resolveAliasConfigPath()". */
function resolveAliasFile(file: string): string {
  return file === "" ? resolveAliasConfigPath() : file;
}

/** Read a JSON file as a plain object. Missing file → empty object (that's
 *  the legitimate "no aliases yet" case). A malformed `agency.json` is NOT
 *  silently swallowed — it's surfaced with the file path so the user can
 *  fix it, since silently treating it as `{}` would lose all their config
 *  on the next write. */
function readJson(file: string): Record<string, any> {
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${(err as Error).message}`);
  }
}

/** Merge `client.modelAliases[name] = uri` (or remove it) into a config
 *  object using spread, so we never mutate the read-in object and the
 *  resulting code is declarative. Pass `uri = undefined` to remove. */
function withAlias(
  cfg: Record<string, any>,
  name: string,
  uri: string | undefined,
): Record<string, any> {
  const existing = cfg.client?.modelAliases ?? {};
  const nextAliases = { ...existing };
  if (uri === undefined) {
    delete nextAliases[name];
  } else {
    nextAliases[name] = uri;
  }
  return {
    ...cfg,
    client: { ...(cfg.client ?? {}), modelAliases: nextAliases },
  };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function readModelAliases(file: string = ""): Record<string, string> {
  const cfg = readJson(resolveAliasFile(file));
  return (cfg.client?.modelAliases ?? {}) as Record<string, string>;
}

/** Entry returned by `_listModelNames`. Curated entries carry full metadata;
 *  user aliases only know their target string, so the optional fields are
 *  populated for `source === "curated"` and omitted (left undefined) for
 *  `source === "alias"`. Consumers can branch on `source` to decide. */
export type ModelNameEntry = {
  name: string;
  target: string;
  source: "curated" | "alias";
  // Curated-only fields (undefined for user aliases):
  params?: string;
  sizeBytes?: number;
  category?: ModelCategory;
  description?: string;
  contextWindow?: number;
  license?: string;
};

export function _resolveModelName(value: string, file: string = ""): string {
  if (isGgufPath(value) || isModelUri(value)) {
    return value;
  }
  const aliases = readModelAliases(file);
  const aliasTarget = aliases[value];
  const curated = CURATED_LOCAL_MODELS[value];
  const mapped = aliasTarget ?? curated?.uri;
  if (!mapped) {
    const names = [...Object.keys(CURATED_LOCAL_MODELS), ...Object.keys(aliases)].join(", ");
    throw new Error(
      `Unknown local model "${value}". Known names: ${names || "(none)"}; ` +
        `or pass a .gguf path or an "hf:" URI.`,
    );
  }
  return mapped;
}

export function _listModelNames(file: string = ""): ModelNameEntry[] {
  const curated: ModelNameEntry[] = Object.entries(CURATED_LOCAL_MODELS).map(
    ([name, info]) => ({
      name,
      target: info.uri,
      source: "curated",
      params: info.params,
      sizeBytes: info.sizeBytes,
      category: info.category,
      description: info.description,
      contextWindow: info.contextWindow,
      license: info.license,
    }),
  );
  const aliases: ModelNameEntry[] = Object.entries(readModelAliases(file)).map(
    ([name, target]) => ({ name, target, source: "alias" }),
  );
  return [...curated, ...aliases];
}

export function _aliasModel(name: string, uri: string, file: string = ""): string {
  const resolved = resolveAliasFile(file);
  writeJson(resolved, withAlias(readJson(resolved), name, uri));
  return resolved;
}

/** Remove an alias. Bails early (no write) if the config file is missing OR
 *  the alias isn't present, so we never create a stub config or rewrite an
 *  untouched file. Returns the resolved path either way so callers can show
 *  the user which file was inspected. */
export function _unaliasModel(name: string, file: string = ""): string {
  const resolved = resolveAliasFile(file);
  if (!fs.existsSync(resolved)) {
    return resolved;
  }
  const cfg = readJson(resolved);
  if (!cfg.client?.modelAliases || !(name in cfg.client.modelAliases)) {
    return resolved;
  }
  writeJson(resolved, withAlias(cfg, name, undefined));
  return resolved;
}

export function _listDownloadedModels(
  cacheDir: string = "",
): { name: string; path: string; sizeBytes: number }[] {
  const dir = resolveCacheDir(cacheDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".gguf"))
    .map((f) => {
      const p = path.join(dir, f);
      return { name: f, path: p, sizeBytes: fs.statSync(p).size };
    });
}

export function _removeModel(name: string, cacheDir: string = ""): boolean {
  const p = path.join(resolveCacheDir(cacheDir), name);
  if (!fs.existsSync(p)) {
    return false;
  }
  fs.rmSync(p);
  return true;
}

/** True if smoltalk-llama-cpp resolves from here. Uses createRequire instead
 *  of import.meta.resolve so this works under any ESM-capable Node we ship
 *  for (minimum Node ≥20.6 is fine either way, but createRequire is the
 *  pattern used elsewhere in the codebase). */
export function _localModelsSupported(): boolean {
  try {
    createRequire(import.meta.url).resolve("smoltalk-llama-cpp");
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run, expect PASS** — same command.

- [ ] **Step 5: Verify every curated URI resolves on Hugging Face** — the catalog mixes maintainer-extrapolated GGUF repo paths (`unsloth/X-GGUF`, `bartowski/X-GGUF`) with confirmed entries (`HuggingFaceTB/...`, `mistralai/Devstral-Small-2507_gguf`, `nomic-ai/...`). The unit test only asserts the entry shape, not that the URI actually resolves. For each `CURATED_LOCAL_MODELS` entry:
  1. Open `https://huggingface.co/<org>/<repo>` in a browser.
  2. Confirm the `Q4_K_M.gguf` file exists in the **Files** tab.
  3. Update `sizeBytes` to match the file's actual byte size (HF shows it on hover).
  4. If the extrapolated repo doesn't exist, search for the family + "GGUF" on HF and substitute the real published repo (then update the URI).
  5. For `smollm2-135m` specifically: this entry is also the integration-test fixture; once verified, capture the SHA256 (Task 12 Step 1's `EXPECTED_SHA256`).

A quick way to batch-check: pipe each URI through `huggingface-cli download <repo> --include "*Q4_K_M*" --dry-run` and confirm it lists the file. Document any substitutions in the commit message.

- [ ] **Step 6: Commit**
```bash
git add lib/stdlib/localModels.ts lib/stdlib/localModels.test.ts
git commit -m "feat(local-model): catalog, name/alias resolution, list/remove"
```

---

### Task 4: General `registerProviderModule` (extract shared loader)

**Files:** Modify `lib/runtime/providerModules.ts`; Modify `lib/stdlib/llm.ts`; Create `lib/stdlib/llm.registerProviderModule.test.ts`

- [ ] **Step 1: Failing test** — `lib/stdlib/llm.registerProviderModule.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as smoltalk from "smoltalk";
import { _registerProviderModule } from "./llm.js";
import { __resetLoadedProviderModules } from "../runtime/providerModules.js";

const here = import.meta.dirname;
const tmp: string[] = [];
afterEach(() => {
  for (const p of tmp.splice(0)) { try { fs.unlinkSync(p); } catch { } }
  smoltalk.unregisterProvider("rpm-test");
  __resetLoadedProviderModules();
});

it("loads a module by path and registers its provider", async () => {
  const p = path.join(here, "__tmp_rpm.mjs");
  fs.writeFileSync(p, `import { BaseClient } from "smoltalk";
    class RPM extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
    export function register({ registerProvider }) { registerProvider("rpm-test", RPM); }`);
  tmp.push(p);
  await _registerProviderModule(p);
  expect(smoltalk.getClient({ model: "m", provider: "rpm-test" }).constructor.name).toBe("RPM");
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test:run lib/stdlib/llm.registerProviderModule.test.ts 2>&1 | tee /tmp/t4.txt`.

- [ ] **Step 3: Extract the shared single-module loader** in `lib/runtime/providerModules.ts`. Replace the body of the `for` loop inside `loadProviderModules` with a call to a new exported function, and define that function with the loop body (reserve-before-await + un-reserve-on-failure + register injection — unchanged logic, just extracted):
```ts
/** Load one provider module by path and register its provider into agency's
 *  own smoltalk. Idempotent per process (the loaded-Set guard). Shared by
 *  `loadProviderModules` (bootstrap) and `std::llm`'s runtime
 *  `registerProviderModule`. */
export async function loadProviderModuleByPath(raw: string): Promise<void> {
  const resolved = resolvePath(raw);
  if (loadedModulePaths.has(resolved)) return;
  loadedModulePaths.add(resolved);
  try {
    let mod: { register?: unknown };
    try {
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
      await (mod.register as (api: { registerProvider: typeof registerProvider }) => unknown)({ registerProvider });
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
```
Then make `loadProviderModules` delegate:
```ts
export async function loadProviderModules(ctx: { providerModules?: string[] }): Promise<void> {
  const configured = [...(ctx.providerModules ?? []), ...envProviderModules()];
  for (const raw of configured) {
    await loadProviderModuleByPath(raw);
  }
}
```
(Keep `resolvePath`, `envProviderModules`, `loadedModulePaths`, `__resetLoadedProviderModules`, and the `registerProvider`/`pathToFileURL` imports as they are.)

- [ ] **Step 4: Add the std::llm builtin** in `lib/stdlib/llm.ts`:
```ts
import { loadProviderModuleByPath } from "../runtime/providerModules.js";

/** Load a provider module by path at runtime and register its provider into
 *  agency's own smoltalk — the runtime counterpart of `loadProviderModules`
 *  (which runs at bootstrap). Lets any program register a custom provider on
 *  demand. */
export async function _registerProviderModule(modulePath: string): Promise<void> {
  await loadProviderModuleByPath(modulePath);
}
```

- [ ] **Step 5: Run, expect PASS**; also run the existing provider-module tests to confirm the refactor is behavior-preserving:
```bash
pnpm test:run lib/stdlib/llm.registerProviderModule.test.ts lib/runtime/providerModules.test.ts 2>&1 | tee /tmp/t4.txt
```
Expected: all pass.

- [ ] **Step 6: Commit**
```bash
git add lib/runtime/providerModules.ts lib/stdlib/llm.ts lib/stdlib/llm.registerProviderModule.test.ts
git commit -m "feat(llm): runtime registerProviderModule (extract shared loader)"
```

---

### Task 5: Bundled module + download/register functions

**Files:** Create `lib/stdlib/providers/llama-cpp.mjs`; Modify `Makefile`; Modify `lib/stdlib/localModels.ts`; add tests to `lib/stdlib/localModels.test.ts`

- [ ] **Step 1: Create the bundled module** — `lib/stdlib/providers/llama-cpp.mjs`:
```js
// Bundled llama-cpp provider module. Loaded on demand by localModels.ts
// (never statically imported by agency-lang), so smoltalk-llama-cpp stays a
// non-dependency. Plain .mjs: shipped via the Makefile copy, outside TS lint.
import { LlamaCPP } from "smoltalk-llama-cpp";
import { existsSync } from "node:fs";
import { splitModelPath } from "./llamaModelConfig.js";

class LocalLlamaCPP extends LlamaCPP {
  constructor(config) {
    const metadata = { ...(config.metadata ?? {}) };
    if (config.model && !metadata.llamaCppModelDir) {
      const split = splitModelPath(config.model);
      metadata.llamaCppModelDir = split.llamaCppModelDir;
      super({ ...config, model: split.model, metadata });
      return;
    }
    super({ ...config, metadata });
  }
}

export function register({ registerProvider }) {
  registerProvider("llama-cpp", LocalLlamaCPP);
}

async function loadNodeLlamaCpp() {
  try {
    const parent = import.meta.resolve("smoltalk-llama-cpp");
    return await import(import.meta.resolve("node-llama-cpp", parent));
  } catch {
    return await import("node-llama-cpp");
  }
}

export async function resolveModel(uriOrPath, cacheDir) {
  if (uriOrPath.endsWith(".gguf") && existsSync(uriOrPath)) return uriOrPath;
  const { resolveModelFile } = await loadNodeLlamaCpp();
  return await resolveModelFile(uriOrPath, { directory: cacheDir, cli: true });
}
```

> Note: confirm against an installed `smoltalk-llama-cpp` whether `LlamaCPP` wants `model`=basename + `metadata.llamaCppModelDir` (the README split, used here) or a full path. If full path: keep `metadata.llamaCppModelDir = split.llamaCppModelDir` but pass `model: config.model` unchanged. `splitModelPath` already returns both pieces.

- [ ] **Step 2: Makefile copy** — in `build:`, after the `runShim` copy:
```makefile
	mkdir -p dist/lib/stdlib/providers
	cp lib/stdlib/providers/*.mjs dist/lib/stdlib/providers/
```

- [ ] **Step 3: Add the provider functions** to `lib/stdlib/localModels.ts`. Two contracts worth highlighting:
  - **`bundledLlamaModule()` returns an absolute filesystem path, NOT a `file://` URL.** `loadProviderModuleByPath` (extracted in Task 4) runs its argument through `path.isAbsolute` / `path.resolve(cwd, ...)`, which would corrupt a URL string into garbage. We compute the fs path once via `fileURLToPath(new URL("./providers/llama-cpp.mjs", import.meta.url))`.
  - **`requireSupport()` skips the smoltalk-llama-cpp install check when `AGENCY_LLAMA_PROVIDER_MODULE` is set** — the override is an explicit "I'm supplying the provider myself" signal (used by tests and by advanced users with a vendored module). This is documented in the spec under §5.

```ts
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadProviderModuleByPath } from "../runtime/providerModules.js";

type LlamaBundle = {
  resolveModel?: (uriOrPath: string, cacheDir: string) => Promise<string>;
};

/** Absolute fs path of the bundled llama-cpp provider module. Tests/advanced
 *  callers can override via AGENCY_LLAMA_PROVIDER_MODULE (also an fs path). */
function bundledLlamaModule(): string {
  return (
    process.env.AGENCY_LLAMA_PROVIDER_MODULE ??
    fileURLToPath(new URL("./providers/llama-cpp.mjs", import.meta.url))
  );
}

/** Guard the install-required commands. Honored even with the override OFF:
 *  if the user set AGENCY_LLAMA_PROVIDER_MODULE they're supplying a provider
 *  module directly, so skip the smoltalk-llama-cpp resolve check. */
function requireSupport(): void {
  if (process.env.AGENCY_LLAMA_PROVIDER_MODULE) {
    return;
  }
  if (!_localModelsSupported()) {
    throw new Error("Local models need smoltalk-llama-cpp — run: npm i -g smoltalk-llama-cpp");
  }
}

/** Register the llama-cpp provider into agency's own smoltalk. */
export async function _registerLocalProvider(): Promise<void> {
  requireSupport();
  await loadProviderModuleByPath(bundledLlamaModule());
}

/** Resolve a name/uri/path to a local .gguf path, downloading if needed.
 *  The returned path is always absolute (resolveModelFile guarantees this for
 *  hf: URIs; existing .gguf paths are passed through and should be absolute
 *  in any sensible caller). */
export async function _downloadModel(value: string, cacheDir: string = ""): Promise<string> {
  requireSupport();
  const target = _resolveModelName(value);
  const fsPath = bundledLlamaModule();
  let mod: LlamaBundle;
  try {
    // eslint-disable-next-line no-restricted-syntax -- on-demand load of the optional provider module
    mod = (await import(pathToFileURL(fsPath).href)) as LlamaBundle;
  } catch (err) {
    throw new Error(`Failed to load the local-model provider: ${(err as Error).message}`);
  }
  if (typeof mod.resolveModel !== "function") {
    throw new Error(`Local-model provider module must export resolveModel().`);
  }
  return await mod.resolveModel(target, resolveCacheDir(cacheDir));
}

/** Convenience: register the provider + ensure the model is downloaded. */
export async function _registerLocalModel(value: string, cacheDir: string = ""): Promise<string> {
  await _registerLocalProvider();
  return await _downloadModel(value, cacheDir);
}
```

- [ ] **Step 4: Add download/register tests** to `lib/stdlib/localModels.test.ts`:
```ts
import { _registerLocalProvider, _downloadModel, _registerLocalModel } from "./localModels.js";
import * as smoltalkPkg from "smoltalk";
import { __resetLoadedProviderModules } from "../runtime/providerModules.js";

describe("provider register + download (fake bundled module)", () => {
  const here2 = import.meta.dirname;
  const fakes: string[] = [];
  function fakeModule(): string {
    const p = path.join(here2, "__tmp_fakellama.mjs");
    fs.writeFileSync(p, `import { BaseClient } from "smoltalk";
      class FakeLlama extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
      export function register({ registerProvider }) { registerProvider("llama-cpp", FakeLlama); }
      export async function resolveModel(target) { return "RESOLVED:" + target; }`);
    fakes.push(p);
    return p;
  }
  afterEach(() => {
    for (const p of fakes.splice(0)) { try { fs.unlinkSync(p); } catch { } }
    delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
    smoltalkPkg.unregisterProvider("llama-cpp");
    __resetLoadedProviderModules();
  });

  it("registers the provider", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    await _registerLocalProvider();
    expect(smoltalkPkg.getClient({ model: "m", provider: "llama-cpp" }).constructor.name).toBe("FakeLlama");
  });
  it("downloads (resolves) a curated name to a path", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    const k = Object.keys(CURATED_LOCAL_MODELS)[0];
    expect(await _downloadModel(k, "/cache")).toBe("RESOLVED:" + CURATED_LOCAL_MODELS[k].uri);
  });
  it("registerLocalModel registers and returns the resolved path", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    expect(await _registerLocalModel("/abs/my.gguf", "/cache")).toBe("RESOLVED:/abs/my.gguf");
    expect(smoltalkPkg.getClient({ model: "m", provider: "llama-cpp" }).constructor.name).toBe("FakeLlama");
  });
});
```

- [ ] **Step 5: Build + run + lint**
```bash
pnpm build 2>&1 | tail -3
ls dist/lib/stdlib/providers/llama-cpp.mjs dist/lib/stdlib/providers/llamaModelConfig.js
pnpm test:run lib/stdlib/localModels.test.ts 2>&1 | tee /tmp/t5.txt
npx eslint lib/stdlib/localModels.ts 2>&1 | tail -3
```
Expected: build copies the `.mjs`; tests pass; lint clean.

- [ ] **Step 6: Commit**
```bash
git add lib/stdlib/providers/llama-cpp.mjs Makefile lib/stdlib/localModels.ts lib/stdlib/localModels.test.ts
git commit -m "feat(local-model): bundled provider + download/register functions"
```

---

### Task 6: Agency wrappers

**Files:** Create `stdlib/agency/local.agency`; Modify `stdlib/llm.agency`

- [ ] **Step 1: `stdlib/agency/local.agency`** — all `cacheDir` defaults are `""`, and the TS side (see Task 3 Step 3) treats `""` as "use the per-user cache default", so the wrappers stay trivial passthroughs:
```
import {
  _localModelsSupported,
  _resolveModelName,
  _downloadModel,
  _listDownloadedModels,
  _listModelNames,
  _aliasModel,
  _unaliasModel,
  _removeModel,
  _registerLocalProvider,
  _registerLocalModel,
} from "agency-lang/stdlib-lib/localModels.js"

/** @module
  Manage and run local models (GGUF via smoltalk-llama-cpp). Download by
  curated short name or Hugging Face URI, alias names, list/remove downloads,
  and register the local provider for `llm()` calls. Requires the
  smoltalk-llama-cpp package to be installed.
*/

export type DownloadedModel = { name: string, path: string, sizeBytes: number }

/** A listed model name. Curated entries carry full metadata; user aliases
 *  carry only `name`/`target`/`source` (the metadata fields are undefined). */
export type ModelName = {
  name: string,
  target: string,
  source: string,            // "curated" | "alias"
  params: string | undefined,
  sizeBytes: number | undefined,
  category: string | undefined,
  description: string | undefined,
  contextWindow: number | undefined,
  license: string | undefined,
}

export def localModelsSupported(): bool {
  """True if smoltalk-llama-cpp is installed."""
  return _localModelsSupported()
}

export def resolveModelName(value: string): string {
  """Map a curated short name or alias to its Hugging Face URI; pass URIs and .gguf paths through. @param value - name, alias, hf: URI, or .gguf path"""
  return _resolveModelName(value)
}

export def downloadModel(value: string, cacheDir: string = ""): string {
  """Download a model (curated name, alias, hf: URI) if not cached and return its local .gguf path. @param value - what to download @param cacheDir - download dir (empty string = per-user cache)"""
  return _downloadModel(value, cacheDir)
}

export def listDownloadedModels(cacheDir: string = ""): DownloadedModel[] {
  """List downloaded .gguf models. @param cacheDir - models dir (empty string = per-user cache)"""
  return _listDownloadedModels(cacheDir)
}

export def listModelNames(): ModelName[] {
  """List usable short names: curated built-ins and your aliases."""
  return _listModelNames()
}

export def aliasModel(name: string, uri: string): string {
  """Add a short-name alias for a model URI; returns the edited agency.json path. @param name - the alias @param uri - the hf: URI it maps to"""
  return _aliasModel(name, uri)
}

export def unaliasModel(name: string): string {
  """Remove a short-name alias; returns the inspected agency.json path (file unchanged if the alias was missing). @param name - the alias to remove"""
  return _unaliasModel(name)
}

export def removeModel(name: string, cacheDir: string = ""): bool {
  """Delete a downloaded model file; false if it was not present. @param name - the .gguf filename @param cacheDir - models dir (empty string = per-user cache)"""
  return _removeModel(name, cacheDir)
}

export def registerLocalProvider() {
  """Register the llama-cpp provider so local models can be used by llm()."""
  _registerLocalProvider()
}

export def registerLocalModel(value: string, cacheDir: string = ""): string {
  """Register the provider and ensure the model is downloaded; returns the local .gguf path to pass to setModel/setLlmOptions with provider "llama-cpp". @param value - name, alias, hf: URI, or .gguf path @param cacheDir - download dir (empty string = per-user cache)"""
  return _registerLocalModel(value, cacheDir)
}
```

- [ ] **Step 2: `registerProviderModule` wrapper** in `stdlib/llm.agency` — extend the stdlib-lib import and add:
```
import { _setLlmOptions, _registerProviderModule } from "agency-lang/stdlib-lib/llm.js"
```
```
export def registerProviderModule(path: string) {
  """
  Load a provider module by path at runtime and register its custom provider
  for llm() calls. The module must export register({ registerProvider }).

  @param path - Path to the provider module (.mjs/.js)
  """
  _registerProviderModule(path)
}
```

- [ ] **Step 3: Build stdlib + verify both modules compile**
```bash
make 2>&1 | tail -5
pnpm run agency compile stdlib/agency/local.agency 2>&1 | tail -3
pnpm run agency compile stdlib/llm.agency 2>&1 | tail -3
```
Expected: compile clean.

- [ ] **Step 4: Commit**
```bash
git add stdlib/agency/local.agency stdlib/agency/local.js stdlib/llm.agency stdlib/llm.js lib/stdlib/localModels.ts
git commit -m "feat(local-model): stdlib/agency/local + registerProviderModule wrappers"
```

---

### Task 7: `agency local` CLI

**Files:** Create `lib/cli/local.ts`; Modify `scripts/agency.ts`; Create `lib/cli/local.test.ts`

- [ ] **Step 1: Failing test** — `lib/cli/local.test.ts`. We pass an explicit `file` argument through the action helpers (same pattern as Task 3) so the test never touches `process.cwd()`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { aliasAdd, aliasList, aliasRemove } from "./local.js";

let dir: string;
let aliasFile: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")));
  aliasFile = path.join(dir, "agency.json");
  fs.writeFileSync(aliasFile, "{}"); // so we never fall back to ~/agency.json
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it("alias add/list/remove round-trips through agency.json and prints the file", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    aliasAdd("my7b", "hf:org/repo:Q4_K_M", aliasFile);
    expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases.my7b)
      .toBe("hf:org/repo:Q4_K_M");
    expect(log.mock.calls.flat().some((s) => String(s).includes(aliasFile))).toBe(true);

    expect(aliasList(aliasFile).some((m) => m.name === "my7b" && m.source === "alias")).toBe(true);

    aliasRemove("my7b", aliasFile);
    expect(JSON.parse(fs.readFileSync(aliasFile, "utf-8")).client.modelAliases.my7b)
      .toBeUndefined();
  } finally {
    log.mockRestore();
  }
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test:run lib/cli/local.test.ts 2>&1 | tee /tmp/t7.txt`.

- [ ] **Step 3: Implement** — `lib/cli/local.ts` (thin handlers over `localModels.ts`; `gate()` enforces the install check for the I/O commands; alias add/remove always echo the resolved `agency.json` path so the user knows which file changed — and, in the global fallback case, that it was `~/agency.json`):
```ts
import {
  _localModelsSupported,
  _resolveModelName,
  _downloadModel,
  _listDownloadedModels,
  _listModelNames,
  _aliasModel,
  _unaliasModel,
  _removeModel,
} from "../stdlib/localModels.js";

const BYTES_PER_GB = 1e9;

function formatGB(bytes: number): string {
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

function gate(): void {
  if (!_localModelsSupported()) {
    console.error("Local models need smoltalk-llama-cpp — run: npm i -g smoltalk-llama-cpp");
    process.exit(1);
  }
}

// Test-facing helpers: take an optional `file` so the unit tests don't have
// to mutate process.cwd(). Production CLI wiring (Step 4) passes `undefined`,
// which the underlying functions resolve via the walk-up rule.
export function aliasList(file?: string) {
  return _listModelNames(file ?? "");
}

export function aliasAdd(name: string, uri: string, file?: string): string {
  const written = _aliasModel(name, uri, file ?? "");
  console.log(`Aliased "${name}" → ${uri} in ${written}`);
  return written;
}

export function aliasRemove(name: string, file?: string): string {
  const inspected = _unaliasModel(name, file ?? "");
  console.log(`Removed alias "${name}" (from ${inspected})`);
  return inspected;
}

export function runList(): void {
  gate();
  const models = _listDownloadedModels();
  if (models.length === 0) {
    console.log("No models downloaded.");
    return;
  }
  for (const m of models) {
    console.log(`${m.name}\t${formatGB(m.sizeBytes)}`);
  }
  const total = models.reduce((sum, m) => sum + m.sizeBytes, 0);
  console.log(`Total: ${formatGB(total)}`);
}

export async function runDownload(value: string): Promise<void> {
  gate();
  console.log(await _downloadModel(value));
}

export function runRemove(name: string): void {
  gate();
  const removed = _removeModel(name);
  console.log(removed ? `Removed ${name}` : `Not found: ${name}`);
}

export function runResolve(value: string): void {
  console.log(_resolveModelName(value));
}

export function runAliasList(): void {
  // Curated entries show name, params, category, size, and description.
  // User aliases show only what they have (name + target).
  for (const m of _listModelNames()) {
    if (m.source === "curated") {
      const size = m.sizeBytes ? formatGB(m.sizeBytes) : "?";
      console.log(`${m.name}\t${m.params}\t${m.category}\t${size}\t${m.description}`);
    } else {
      console.log(`${m.name}\t${m.target}\t(alias)`);
    }
  }
}

export function runAliasAdd(name: string, uri: string): void {
  aliasAdd(name, uri);
}

export function runAliasRemove(name: string): void {
  aliasRemove(name);
}
```

- [ ] **Step 4: Wire into `scripts/agency.ts`** — near the other `program.command(...)` definitions, add:
```ts
import {
  runList as localList,
  runDownload as localDownload,
  runRemove as localRemove,
  runResolve as localResolve,
  runAliasList as localAliasList,
  runAliasAdd as localAliasAdd,
  runAliasRemove as localAliasRemove,
} from "../lib/cli/local.js";
```
```ts
  const localCmd = program.command("local").description("Manage and run local models");
  localCmd.command("list").description("List downloaded models").action(localList);
  localCmd.command("download").description("Download a model (curated name, alias, or hf: URI)")
    .argument("<value>").action(localDownload);
  localCmd.command("remove").description("Delete a downloaded model").argument("<name>")
    .action(localRemove);
  localCmd.command("resolve").description("Show what a name/alias resolves to").argument("<value>")
    .action(localResolve);
  const aliasCmd = localCmd.command("alias").description("Manage model name aliases");
  aliasCmd.command("list").description("List usable short names (curated + aliases)").action(localAliasList);
  aliasCmd.command("add").description("Add a short-name alias").argument("<name>").argument("<uri>")
    .action(localAliasAdd);
  aliasCmd.command("remove").description("Remove a short-name alias").argument("<name>")
    .action(localAliasRemove);
```
> Commander handles async `.action(...)` natively and passes positional arguments in order, so we don't need wrapper arrow functions.
> Note: match the exact import-path style `scripts/agency.ts` already uses for `lib/cli/*` (relative vs `@/`); copy a neighboring import. Place the block where other commands are registered (e.g. near the `agent`/`doc` commands).

- [ ] **Step 5: Build + run test + smoke the CLI**
```bash
make 2>&1 | tail -3
pnpm test:run lib/cli/local.test.ts 2>&1 | tee /tmp/t7.txt
pnpm run agency local alias list 2>&1 | tail -10   # curated names print even without smoltalk-llama-cpp
```
Expected: test passes; `alias list` prints the curated names (it doesn't gate on support).

- [ ] **Step 6: Commit**
```bash
git add lib/cli/local.ts lib/cli/local.test.ts scripts/agency.ts
git commit -m "feat(cli): agency local (list/download/remove/resolve + alias group)"
```

---

### Task 8: Agent `--local-model`

**Files:** Modify `lib/agents/agency-agent/agent.agency` + `shared.agency`

- [ ] **Step 1: `configureLocalModel` in `shared.agency`** — add the import (extend the `std::agency/local` usage; if the agent doesn't import it yet, add the import line) and function:
```
import { registerLocalModel } from "std::agency/local"
```
```
/** Apply a local model (from `--local-model`) as BOTH the fast and slow
 *  model: register the llama-cpp provider, download the model if needed into
 *  the agent's models cache, and point every LLM call — including the deep
 *  subagents — at it, so a fully-local run needs no hosted-provider key. */
export def configureLocalModel(value: string) {
  const modelPath = registerLocalModel(value, "${AGENCY_AGENT_DIR}/models")
  setLlmOptions({ model: modelPath, provider: "llama-cpp" })
  slowModel = modelPath
  slowProvider = "llama-cpp"
}
```
> Note: verify the `std::agency/local` import specifier resolves (submodule import). If the toolchain expects a different form for `stdlib/agency/local.agency`, mirror how `stdlib/agency/eval.agency` is imported elsewhere.

- [ ] **Step 2: Flag + branch in `agent.agency`** — add to the `flags:` object (quoted key):
```
      "local-model": {
        type: "string",
        description: "Run a local model (downloads if needed): a curated short name, an hf: URI, or a .gguf path. Sets fast+slow to the local model and ignores --model/--provider/--fastmodel/--slowmodel. Requires: npm i -g smoltalk-llama-cpp"
      },
```
Replace the `configureModels(...)` call with the branch, and extend the `./shared.agency` import:
```
import { configureModels, configureLocalModel } from "./shared.agency"
```
```
  const localModel = args.flags["local-model"] ?? ""
  if (localModel != "") {
    configureLocalModel(localModel)
  } else {
    configureModels(
      args.flags.model ?? "",
      args.flags.fastmodel ?? "",
      args.flags.slowmodel ?? "",
      args.flags.provider ?? "",
    )
  }
```

- [ ] **Step 3: Build + verify the flag**
```bash
make 2>&1 | tail -5
pnpm run agency agent --help 2>&1 | grep -A1 "local-model"
```
Expected: build succeeds; the flag appears in help.

- [ ] **Step 4: Commit**
```bash
git add lib/agents/agency-agent/agent.agency lib/agents/agency-agent/shared.agency
git commit -m "feat(agent): --local-model flag (composes the local-model primitives)"
```

---

### Task 9: End-to-end agency-js test

Proves the agency `std::agency/local` → TS wiring through a real compile+run, using a fake bundled module (no download/LLM), via `AGENCY_LLAMA_PROVIDER_MODULE`.

**Files (Create, in `tests/agency-js/local-model/`):**

- [ ] **Step 1: Fake module** — `tests/agency-js/local-model/fake-llama.mjs`:
```js
import { BaseClient } from "smoltalk";
class FakeLlama extends BaseClient {
  async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; }
}
export function register({ registerProvider }) { registerProvider("llama-cpp", FakeLlama); }
export async function resolveModel(target) { return "RESOLVED:" + target; }
```

- [ ] **Step 2: Program** — `tests/agency-js/local-model/agent.agency`:
```
import { registerLocalModel } from "std::agency/local"

node main(): string {
  return registerLocalModel("/abs/my.gguf", "/tmp/agency-localmodel-test")
}
```

- [ ] **Step 3: Driver** — `tests/agency-js/local-model/test.js`:
```js
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as smoltalk from "smoltalk";
import { writeFileSync } from "fs";

const here = dirname(fileURLToPath(import.meta.url));
process.env.AGENCY_LLAMA_PROVIDER_MODULE = join(here, "fake-llama.mjs");

const { main } = await import("./agent.js");
const result = await main();

let provider = "ERR";
try { provider = smoltalk.getClient({ model: "m", provider: "llama-cpp" }).constructor.name; }
catch (e) { provider = "ERR:" + e.message; }

writeFileSync("__result.json", JSON.stringify({ path: result.data, provider }, null, 2));
```

- [ ] **Step 4: Fixture** — `tests/agency-js/local-model/fixture.json`:
```json
{
  "path": "RESOLVED:/abs/my.gguf",
  "provider": "FakeLlama"
}
```

- [ ] **Step 5: Build + run**
```bash
make 2>&1 | tail -3
pnpm run agency test js tests/agency-js/local-model 2>&1 | tee /tmp/t9.txt
```
Expected: passes. (If a `log.jsonl` is emitted into the dir, `git rm --cached` it before committing — generated artifact.)

- [ ] **Step 6: Commit**
```bash
git add tests/agency-js/local-model
git commit -m "test(agency-js): end-to-end registerLocalModel via fake provider"
```

---

### Task 10: Documentation

**Files:** Modify `docs/site/guide/custom-providers.md`

- [ ] **Step 1: Add sections** at the top of `docs/site/guide/custom-providers.md`, after the intro paragraph (use real triple backticks in the file):

```markdown
## Local models (the easy way)

Install the local-model package once, then use the `agency local` tools or the
agent's `--local-model` flag:

[bash code block]
npm i -g smoltalk-llama-cpp

agency local download qwen2.5-7b          # curated name, hf: URI, or .gguf path
agency local list                         # downloaded models + sizes
agency local alias add my7b hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
agency local alias list                   # curated names + your aliases
agency local remove qwen2.5-7b

agency agent --local-model qwen2.5-7b     # download (if needed) + run locally
[end block]

`--local-model` runs the local model as both the fast and slow model, so the
deep subagents stay local too; it ignores `--model`/`--provider`/`--fastmodel`/
`--slowmodel`. Downloads cache under `~/.agency-agent/models` (override with
`AGENCY_MODELS_DIR`).

Programmatically, `std::agency/local` exposes the same operations
(`downloadModel`, `listDownloadedModels`, `aliasModel`, `registerLocalModel`,
…), and `std::llm`'s `registerProviderModule(path)` registers any custom
provider module at runtime.

The rest of this page covers the fully manual route for any custom provider.

---
```

- [ ] **Step 2: Build (docs copy) + commit**
```bash
pnpm build 2>&1 | tail -2
git add docs/site/guide/custom-providers.md
git commit -m "docs: local-model tools (agency local + --local-model)"
```

---

### Task 11: `agency local` CLI reference page

**Files:** Create `docs/site/cli/local.md`

Matches the style of the other CLI pages (see `docs/site/cli/pack.md`, `docs/site/cli/agent.md`) — frontmatter, a one-liner intro, copy-pasteable examples, an Options/Subcommands table, and a Config section.

- [ ] **Step 1: Write the page** — `docs/site/cli/local.md` (use real triple backticks in the file; `[bash code block]` and `[end block]` are placeholders below):

```markdown
---
title: local
description: Documents the `agency local` command, which downloads, lists, aliases, and removes local GGUF models used by the `llama-cpp` provider.
---

# local

Use this to manage and run local models. Backed by `smoltalk-llama-cpp` + `node-llama-cpp`; install once with `npm i -g smoltalk-llama-cpp` before any subcommand that downloads/inspects models.

[bash code block]
agency local download qwen2.5-7b          # curated name, alias, hf: URI, or .gguf path
agency local list                         # downloaded models + sizes
agency local remove qwen2.5-7b            # delete a downloaded model
agency local resolve my7b                 # show what a name/alias maps to

agency local alias add my7b hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
agency local alias list                   # curated + your aliases
agency local alias remove my7b
[end block]

The agent has a shortcut for the common case:

[bash code block]
agency agent --local-model qwen2.5-7b     # download (if needed) + run locally
[end block]

`--local-model` runs the local model as both the fast and slow model, so the deep subagents stay local too; it ignores `--model`/`--provider`/`--fastmodel`/`--slowmodel`.

### Subcommands

| command | purpose |
|---|---|
| `agency local list` | List downloaded `.gguf` files with sizes and a total. |
| `agency local download <value>` | Download a model if not already cached; prints the resolved local path. `<value>` may be a curated short name, an alias, an `hf:` URI, or an existing `.gguf` path. |
| `agency local remove <name>` | Delete a downloaded `.gguf` from the cache. |
| `agency local resolve <value>` | Show what a name/alias maps to, without downloading. |
| `agency local alias list` | List usable short names: curated built-ins and your aliases. |
| `agency local alias add <name> <uri>` | Add a short-name alias. Prints the `agency.json` path that was edited. |
| `agency local alias remove <name>` | Remove a short-name alias. Prints the `agency.json` path that was inspected (the file is left untouched if the alias wasn't present). |

### Where things live

- **Cache dir**: `~/.agency-agent/models` by default; override with `AGENCY_MODELS_DIR`.
- **Aliases**: written to the nearest `agency.json` walking up from the current directory; if none is found, `~/agency.json` is used. The CLI prints which file it edited on every add/remove.

### Config

Aliases are stored under `client.modelAliases`:

```jsonc
{
  "client": {
    "modelAliases": {
      "my7b": "hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M"
    }
  }
}
```

Read at runtime, so `agency local alias add/remove` edits take effect on the next call.

### See also

- [`agency agent --local-model`](./agent) — the easy button that composes the local-model primitives.
- [Custom providers guide](../guide/custom-providers) — for using any non-llama provider.
```

- [ ] **Step 2: Build the docs site to confirm the page renders**:
```bash
pnpm build 2>&1 | tail -2
ls docs/site/cli/local.md
```

- [ ] **Step 3: Commit**
```bash
git add docs/site/cli/local.md
git commit -m "docs(cli): agency local reference page"
```

---

### Task 12: Real-model integration tests (post-merge CI)

**Files:** Create `tests/integration/local-model/smoltest.test.ts`; Create `tests/integration/local-model/agent-flag.test.ts`; Create `.github/workflows/local-model.yml`; Create `docs/dev/local-model-integration.md`

**Design constraints (committed):**
- `smoltalk-llama-cpp` is **not** added to `package.json` — every user `pnpm install` would otherwise pull `node-llama-cpp`'s 30–100 MB native binary they may never use. The workflow installs it explicitly with `--save=false` at a pinned version. The pin lives in the workflow file (the source of truth for "what version do we test against") and bumps via a one-line PR.
- **Trigger is `push: branches: [main]` only**, mirroring [`test-with-llm.yml`](file:///Users/adityabhargava/agency-lang/.claude/worktrees/declarative-optimize-mutator/.github/workflows/test-with-llm.yml#L12-L14). No `pull_request`, no `pull_request_target`, no label trigger. PRs get the existing fake-provider unit/agency-js suites; integration runs post-merge. This sidesteps the fork-PR / secret-exfiltration / cache-poisoning class of risks by design.
- All third-party actions **pinned to SHA** matching the SHAs already in [`test-with-llm.yml`](file:///Users/adityabhargava/agency-lang/.claude/worktrees/declarative-optimize-mutator/.github/workflows/test-with-llm.yml#L26-L40); only bump in lockstep with the other workflows.
- `permissions: contents: read`. No `secrets:`. The test only fetches from Hugging Face and runs CPU inference — no API keys involved.
- Test suite gated on `AGENCY_LLM_INTEGRATION=1` so a stray local `pnpm test:run` never downloads a model. The suite reroutes `HOME` and `AGENCY_MODELS_DIR` to a temp dir so a local run also doesn't pollute the dev's real `~/.agency-agent/models` or `~/agency.json`.
- After download, the GGUF is **SHA256-verified** against a checked-in expected hash — a tamper canary that catches HF account compromise / mirror MITM / content-swap even in the main-only trigger regime.

- [ ] **Step 1: The smoke test** — `tests/integration/local-model/smoltest.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as smoltalk from "smoltalk";
import {
  _registerLocalModel,
  _downloadModel,
  _listDownloadedModels,
} from "../../../lib/stdlib/localModels.js";

const enabled = process.env.AGENCY_LLM_INTEGRATION === "1";
const TINY = "smollm2-135m";

// SHA256 of the curated SmolLM2-135M-Instruct-Q4_K_M.gguf file. Bump in
// lockstep with any change to the curated URI for this model. Capturing the
// hash here is a tamper canary: HF account compromise or CDN MITM that swaps
// the file fails this assertion loudly even though we only run post-merge.
const EXPECTED_SHA256 = "<fill-in-from-hf-download>";

let tmpHome: string;
let origHome: string | undefined;
let origModelsDir: string | undefined;

beforeAll(() => {
  // Sandbox HOME + the models cache so a local `AGENCY_LLM_INTEGRATION=1`
  // run NEVER touches the dev's real ~/.agency-agent/models or ~/agency.json.
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lm-int-")));
  origHome = process.env.HOME;
  origModelsDir = process.env.AGENCY_MODELS_DIR;
  process.env.HOME = tmpHome;
  process.env.AGENCY_MODELS_DIR = path.join(tmpHome, "models");
});

afterAll(() => {
  process.env.HOME = origHome;
  if (origModelsDir === undefined) {
    delete process.env.AGENCY_MODELS_DIR;
  } else {
    process.env.AGENCY_MODELS_DIR = origModelsDir;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe.runIf(enabled)("local-model integration (real download + inference)", () => {
  it("downloads a real GGUF, file exists, hash matches", async () => {
    const modelPath = await _downloadModel(TINY);
    expect(modelPath).toMatch(/\.gguf$/);
    const buf = fs.readFileSync(modelPath);
    expect(buf.length).toBeGreaterThan(10_000_000); // ~85 MB
    const got = createHash("sha256").update(buf).digest("hex");
    expect(got).toBe(EXPECTED_SHA256);
  }, { timeout: 5 * 60_000 });

  it("second download is a no-op (uses cache)", async () => {
    const first = await _downloadModel(TINY);
    const mtime1 = fs.statSync(first).mtimeMs;
    await new Promise((r) => setTimeout(r, 200));
    const second = await _downloadModel(TINY);
    expect(second).toBe(first);
    expect(fs.statSync(second).mtimeMs).toBe(mtime1);
  }, { timeout: 2 * 60_000 });

  it("listDownloadedModels sees the downloaded file", async () => {
    await _downloadModel(TINY); // ensure present
    const listed = _listDownloadedModels();
    expect(listed.some((m) => m.name.toLowerCase().includes("smollm2-135m"))).toBe(true);
  });

  it("registers the provider and runs real inference (shape-only assertions)", async () => {
    const modelPath = await _registerLocalModel(TINY);
    const client = smoltalk.getClient({ provider: "llama-cpp", model: modelPath });
    const result = await client.textSync({
      messages: [{ role: "user", content: "Reply with one short word." }],
      temperature: 0,
    });
    expect(result.success).toBe(true);
    expect(typeof result.value.output).toBe("string");
    expect(result.value.output.length).toBeGreaterThan(0);
  }, { timeout: 3 * 60_000 });
});
```
> Note: capture `EXPECTED_SHA256` by running the test once with the assertion stubbed to `expect(got).toMatch(/^[0-9a-f]{64}$/)`, then pasting the printed hash. The expected value is committed; subsequent runs verify it.

- [ ] **Step 2: The agent flag end-to-end test** — `tests/integration/local-model/agent-flag.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const enabled = process.env.AGENCY_LLM_INTEGRATION === "1";

describe.runIf(enabled)("agency agent --local-model (end-to-end)", () => {
  it("runs a one-shot prompt and exits 0", async () => {
    const { stdout, stderr } = await exec(
      "pnpm",
      ["run", "agency", "agent", "--local-model", "smollm2-135m", "--print", "Say hi."],
      { timeout: 5 * 60_000 },
    );
    // Shape-only: the model said something and the agent didn't error out.
    expect(stdout.length).toBeGreaterThan(0);
    expect(stderr).not.toMatch(/Error|Traceback/);
  }, { timeout: 6 * 60_000 });
});
```

- [ ] **Step 3: GitHub Actions workflow** — `.github/workflows/local-model.yml`:
```yaml
# Real local-model integration tests. Triggered ONLY on pushes to `main`
# (i.e. after a PR is merged), NOT on pull requests — mirroring
# test-with-llm.yml's threat model. PRs get the fake-provider unit suites in
# test.yml; integration runs post-merge so PR authors can't toggle a label,
# poison the cache, or modify the workflow file in-band.
#
# Security:
# - All third-party actions pinned to SHA (same pins as test-with-llm.yml).
# - smoltalk-llama-cpp is installed with --save=false at a pinned version;
#   it is NOT in package.json (so user `pnpm install` doesn't pull node-llama-cpp).
# - Models cache key is scoped to the model name + version; no restore-keys
#   (a partial / poisoned cache must not be used as a fallback).
# - Test verifies the downloaded GGUF's SHA256 against a committed expected
#   value; HF account compromise or mirror MITM fails the build loudly.
name: local-model integration (post-merge)

on:
  push:
    branches: [ "main" ]
    paths:
      - "packages/agency-lang/lib/stdlib/localModels.ts"
      - "packages/agency-lang/lib/stdlib/providers/**"
      - "packages/agency-lang/tests/integration/local-model/**"
      - ".github/workflows/local-model.yml"

permissions:
  contents: read

jobs:
  local-model-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    env:
      # Bump this in lockstep with smoltalk-llama-cpp upstream releases.
      # node-llama-cpp's version is pinned transitively via smoltalk-llama-cpp's lockfile.
      SMOLTALK_LLAMA_CPP_VERSION: "0.5.2"

    steps:
      - name: Checkout repository
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4

      - name: Set up pnpm
        uses: pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa # v4
        with:
          version: 9
          run_install: false

      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22.x
          cache: 'pnpm'

      - name: Install workspace deps (lockfile-pinned, no smoltalk-llama-cpp yet)
        run: pnpm install --frozen-lockfile

      - name: Build
        run: make

      # Install smoltalk-llama-cpp ONLY here, at a pinned version, without
      # mutating package.json or the lockfile. --save=false keeps both clean.
      - name: Install smoltalk-llama-cpp (pinned, off-lockfile)
        working-directory: packages/agency-lang
        run: pnpm add --save=false smoltalk-llama-cpp@${{ env.SMOLTALK_LLAMA_CPP_VERSION }}

      # Cache the downloaded GGUF + the node-llama-cpp prebuilt binary.
      # Scoped to the model name; no restore-keys — a partial/poisoned cache
      # must never be used as a fallback.
      - name: Cache local models + node-llama-cpp prebuilt
        uses: actions/cache@v4 # TODO: pin to SHA when bumping (see other workflows)
        with:
          path: |
            ~/.agency-agent/models
            ~/.cache/node-llama-cpp
          key: lm-v1-${{ runner.os }}-smollm2-135m-nlc-${{ env.SMOLTALK_LLAMA_CPP_VERSION }}

      - name: Run integration suite
        working-directory: packages/agency-lang
        env:
          AGENCY_LLM_INTEGRATION: "1"
        run: pnpm test:run tests/integration/local-model 2>&1 | tee integration.log

      - name: Upload log on failure
        if: failure()
        uses: actions/upload-artifact@v4 # TODO: pin to SHA when bumping
        with:
          name: integration-log
          path: packages/agency-lang/integration.log
```
> Note: pin `actions/cache@v4` and `actions/upload-artifact@v4` to SHA before merging — match the SHA strategy in [`test-with-llm.yml`](file:///Users/adityabhargava/agency-lang/.claude/worktrees/declarative-optimize-mutator/.github/workflows/test-with-llm.yml).

- [ ] **Step 4: Developer docs** — `docs/dev/local-model-integration.md`:
```markdown
# Local-model integration tests

The fake-provider unit tests (in `lib/stdlib/localModels.test.ts`,
`lib/cli/local.test.ts`, and `tests/agency-js/local-model/`) cover the
wiring deterministically. The integration suite in
`tests/integration/local-model/` additionally exercises a **real download +
real CPU inference** path: it pulls the ~85 MB SmolLM2-135M GGUF from
Hugging Face, registers `node-llama-cpp`, runs a one-shot completion, and
verifies the agent's `--local-model` flag end-to-end.

## When it runs

- **CI**: only on push to `main` (see `.github/workflows/local-model.yml`).
  PRs do NOT run this suite — they get the fake-provider tests in `test.yml`.
- **Locally**: gated on `AGENCY_LLM_INTEGRATION=1`, so a stray `pnpm test:run`
  never downloads a model.

## Running locally

The suite sandboxes `HOME` and `AGENCY_MODELS_DIR` to a temp dir, so it
won't write to your real `~/.agency-agent/models` or `~/agency.json`.

```bash
# In packages/agency-lang/. Install the optional provider (one-time; not in
# package.json, so this doesn't affect normal `pnpm install`).
pnpm add --save=false smoltalk-llama-cpp@0.5.2

# Run the suite.
AGENCY_LLM_INTEGRATION=1 pnpm test:run tests/integration/local-model
```

First run downloads ~85 MB and takes a few minutes; subsequent runs hit the
cache and finish in seconds.

## Updating the model pin

If you change the curated `smollm2-135m` URI in `lib/stdlib/localModels.ts`,
update **two** values:

1. `EXPECTED_SHA256` in `tests/integration/local-model/smoltest.test.ts` —
   capture by running the suite once with the assertion relaxed to a regex,
   then paste the printed hash.
2. The cache key in `.github/workflows/local-model.yml` (bump the `v1` suffix
   or change the model identifier in the key).

## Updating the `smoltalk-llama-cpp` pin

Edit `SMOLTALK_LLAMA_CPP_VERSION` in `.github/workflows/local-model.yml`.
That's the single source of truth. Verify the suite passes against the new
version before merging.
```

- [ ] **Step 5: Build + run a local sanity check** (only if the developer wants to verify before the post-merge run):
```bash
# Skip the install + run if you don't want to incur the download right now.
pnpm test:run tests/integration/local-model 2>&1 | tee /tmp/t12-skip.txt
# Expected: 0 tests run (all describe.runIf(enabled) blocks are skipped).
```
That confirms the gating works without paying the model-download cost.

- [ ] **Step 6: Commit**
```bash
git add tests/integration/local-model .github/workflows/local-model.yml docs/dev/local-model-integration.md lib/stdlib/localModels.ts
git commit -m "test(local-model): real-model integration suite (post-merge CI)"
```

---

## Final verification

- [ ] **Full build + targeted tests + lint**
```bash
make 2>&1 | tee /tmp/final-build.txt | tail -3
pnpm test:run lib/stdlib/localModels.test.ts lib/stdlib/providers/llamaModelConfig.test.ts lib/stdlib/llm.registerProviderModule.test.ts lib/cli/local.test.ts lib/runtime/providerModules.test.ts lib/config.modelAliases.test.ts 2>&1 | tee /tmp/final-unit.txt | tail -8
pnpm run agency test js tests/agency-js/local-model 2>&1 | tee /tmp/final-js.txt | tail -4
pnpm run lint:structure 2>&1 | tail -3
```
Expected: build clean; unit tests green; agency-js test passes; lint clean. (Do not run the full agency test suite locally — CI runs it.)

- [ ] **Open the PR** (only when the user asks). Body to a file (apostrophes on the CLI error out); end with the Generated-with-Claude-Code line.

---

## Self-Review

**Spec coverage:**
- One TS source of truth (`localModels.ts`) exposed as agency + CLI → Tasks 3/5/6/7.
- Functions `localModelsSupported`/`resolveModelName`/`downloadModel`/`listDownloadedModels`/`listModelNames`/`aliasModel`/`unaliasModel`/`removeModel`/`registerLocalProvider`/`registerLocalModel` → Tasks 3 (non-provider) + 5 (provider) + 6 (wrappers).
- `agency local` CLI (list/download/remove/resolve + alias list/add/remove), gated on support, prints the edited `agency.json` on every alias mutation → Task 7.
- General `std::llm registerProviderModule` (extract shared loader) → Tasks 4 + 6.
- `client.modelAliases`, runtime read/write, **walk up from cwd then fall back to `~/agency.json`** → Tasks 2 + 3.
- Bundled provider module + Makefile copy + model-dir defaulting → Tasks 1 + 5.
- Agent `--local-model` composing the primitives, fast+slow → Task 8.
- Cache dir + `AGENCY_MODELS_DIR` + empty-string default convention → Task 3 (`defaultCacheDir` + `resolveCacheDir`).
- Tests: unit + CLI + agency-js e2e → Tasks 1/2/3/4/5/7/9.
- Docs: easy-button + custom-providers guide → Task 10; full `agency local` CLI reference (matches `docs/site/cli/pack.md` style) → Task 11.
- Real-model integration suite (download + inference + agent flag end-to-end), gated on `AGENCY_LLM_INTEGRATION=1`, post-merge CI only, mirrors `test-with-llm.yml`'s threat model → Task 12.
- Curated catalog is a rich `Record<string, ModelInfo>` (uri + params + sizeBytes + category + description + contextWindow + license) covering 15 models across 6 providers and 8 categories (tiny → xl → coding → reasoning → embedding). User aliases stay simple strings → Task 3.

**Resolved review issues (from the spec/plan review):**
- Critical: `bundledLlamaModule()` now returns an **absolute fs path** (via `fileURLToPath`), not a `file://` URL, so `loadProviderModuleByPath`'s `path.isAbsolute`/`path.resolve` doesn't mangle it (Task 5 Step 3).
- Critical: alias add/remove now always **print** which `agency.json` they touched, so the global `~/agency.json` fallback is never silent (Tasks 7 Steps 1+3).
- Critical: `resolveAliasConfigPath` now **walks up** from `cwd` looking for `agency.json` before falling back to `~/agency.json` (Task 3 Step 3), matching the spec.
- `_unaliasModel` **bails early** with no write when the file or alias is missing (Task 3 Step 3).
- Tests no longer mutate `process.cwd()` — `_aliasModel`/`_unaliasModel`/`_resolveModelName`/`_listModelNames` and the CLI helpers take an explicit `file` argument so vitest parallelism is safe (Tasks 3 + 7).
- `_localModelsSupported` uses `createRequire(...).resolve(...)` instead of `import.meta.resolve` (Task 3 Step 3).
- `requireSupport` now skips the install check when `AGENCY_LLAMA_PROVIDER_MODULE` is set; this is called out in the shared-conventions block and surfaced in the spec (Task 5 Step 3).
- Empty-string passthrough is the chosen convention for `cacheDir`/`file` defaults; the agency wrappers are trivial passthroughs and don't import a `_defaultCacheDir` helper (Tasks 3 + 6).
- `scripts/agency.ts` wiring uses `.action(handler)` directly (commander supports async actions natively); no wrapper arrow functions (Task 7 Step 4).

**Anti-pattern audit (vs. `docs/dev/anti-patterns.md`):**
- §"Duplicating existing code" — `resolveAliasConfigPath` reuses the new `findFileUp` helper extracted from `findPackageRoot` in [lib/importPaths.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/importPaths.ts) (Task 2.5).
- §"Imperative code everywhere" — `_listModelNames` uses `.map` + spread (not a `for`+`push` accumulator); `runList` uses `reduce` for the total + a single-purpose `for…of` for printing; `_aliasModel`/`_unaliasModel` route through a single `withAlias` builder that returns a new object via spread.
- §"try-catch without logging" — the catch in `readJson` now surfaces a `Failed to parse <file>: <msg>` error instead of swallowing it; `_localModelsSupported`'s catch is the established "module not resolvable" boolean probe, not an error swallow.
- §"One-line if statements" — every `if` in the plan's code blocks uses `{ … }` blocks.
- §"Magic numbers" — `1e9` is named `BYTES_PER_GB`; the GB formatter is factored into `formatGB(bytes)`.
- §"Putting too much stuff onto a single line" — `runList`'s loop is split; CLI helpers each on their own line/body.
- §"Order-dependent mutable state" — config writes go through `withAlias`'s pure builder; no `cfg.client = cfg.client ?? {}` mutation chains.
- §"Dynamic requires" — kept only where genuinely necessary (loading the optional provider module via `pathToFileURL(fsPath).href`, the sanctioned `// eslint-disable-next-line no-restricted-syntax` exception that already exists in `providerModules.ts`).
- §"Leaky abstractions" — agency wrappers and CLI helpers are thin passthroughs; consumers don't need to know about `_aliasModel`'s file format, `_downloadModel`'s `pathToFileURL` dance, or `loadProviderModuleByPath`'s reserve-before-await guard.

**Type/name consistency:** TS exports are `_`-prefixed (`_resolveModelName`, `_downloadModel`, `_registerLocalProvider`, `_registerLocalModel`, `_registerProviderModule`, `_aliasModel`, `_unaliasModel`, `_listModelNames`, `_listDownloadedModels`, `_removeModel`, `_localModelsSupported`); agency wrappers drop the underscore. `resolveAliasConfigPath`, `CURATED_LOCAL_MODELS`, `splitModelPath`, `loadProviderModuleByPath`, provider `"llama-cpp"`, flag key `"local-model"` (bracket access), env `AGENCY_MODELS_DIR` / `AGENCY_LLAMA_PROVIDER_MODULE`, config `client.modelAliases`, and the bundled-module contract (`register` + `resolveModel`) are spelled identically across tasks.
