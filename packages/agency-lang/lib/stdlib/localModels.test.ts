import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  resolveSmoltalkLlamaCppFromRoots,
  formatModelCatalog,
  resolveCatalogUrl,
  parseCatalog,
  _refreshCatalog,
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
      "general", "coding", "reasoning", "embedding",
    ]);
    // Curated set is permissive-licensed only.
    const permissiveLicenses = new Set(["apache-2.0", "mit"]);
    for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
      expect(info.uri, `${name}.uri`).toMatch(/^hf:/);
      expect(info.params.length, `${name}.params`).toBeGreaterThan(0);
      expect(info.description.length, `${name}.description`).toBeGreaterThan(0);
      expect(info.sizeBytes, `${name}.sizeBytes`).toBeGreaterThan(0);
      expect(info.contextWindow, `${name}.contextWindow`).toBeGreaterThan(0);
      expect(validCategories.has(info.category), `${name}.category=${info.category}`).toBe(true);
      expect(permissiveLicenses.has(info.license), `${name}.license=${info.license}`).toBe(true);
    }
  });
  it("smollm2-135m is present (integration suite depends on it)", () => {
    expect(CURATED_LOCAL_MODELS["smollm2-135m"]).toBeDefined();
    expect(CURATED_LOCAL_MODELS["smollm2-135m"].category).toBe("general");
  });
});

describe("aliases", () => {
  it("add → resolve → list → remove round-trips via the provided file", () => {
    fs.writeFileSync(aliasFile, "{}");
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
    const r1 = _unaliasModel("ghost", aliasFile);
    expect(r1).toEqual({ file: aliasFile, removed: false });
    expect(fs.existsSync(aliasFile)).toBe(false);
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { defaultModel: "x" } }, null, 2));
    const before = fs.readFileSync(aliasFile, "utf-8");
    const r2 = _unaliasModel("ghost", aliasFile);
    expect(r2).toEqual({ file: aliasFile, removed: false });
    expect(fs.readFileSync(aliasFile, "utf-8")).toBe(before);
  });
  it("unaliasModel returns { removed: true } when the alias was actually written out", () => {
    fs.writeFileSync(aliasFile, "{}");
    _aliasModel("toRemove", "hf:x/y:Q4", aliasFile);
    expect(_unaliasModel("toRemove", aliasFile)).toEqual({ file: aliasFile, removed: true });
    // Idempotent: a second remove is a no-op and reports removed=false.
    expect(_unaliasModel("toRemove", aliasFile)).toEqual({ file: aliasFile, removed: false });
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
    expect(Array.isArray(_listDownloadedModels(""))).toBe(true);
  });
});

describe("support check", () => {
  it("returns a boolean (env-dependent: true iff smoltalk-llama-cpp is reachable)", () => {
    // The actual value depends on whether the dev machine has a global
    // install (post-fix this is now expected to be `true` on machines that
    // ran `npm i -g smoltalk-llama-cpp`). The contract is that the check
    // never throws and returns a boolean.
    expect(typeof _localModelsSupported()).toBe("boolean");
  });
});

// Helper: each global `node_modules` root must literally be a directory
// named `node_modules` (the convention `npm root -g` / `pnpm root -g` uses
// — `/opt/homebrew/lib/node_modules`, `~/Library/pnpm/global/5/node_modules`).
// The resolver walks UP from `<root>/..` looking for a `node_modules` sibling,
// which is the root itself.
function makeFakeGlobalRoot(parent: string, name: string): string {
  const root = path.join(parent, name, "node_modules");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function plantFakePackage(root: string, packageName: string): string {
  const pkgDir = path.join(root, packageName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: packageName, version: "0.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};");
  return path.join(pkgDir, "index.js");
}

describe("resolveSmoltalkLlamaCppFromRoots (global-install discovery)", () => {
  it("finds the package in a synthetic global node_modules root", () => {
    const root = makeFakeGlobalRoot(dir, "fake-global");
    const entry = plantFakePackage(root, "smoltalk-llama-cpp");
    expect(resolveSmoltalkLlamaCppFromRoots([root])).toBe(entry);
  });
  it("returns null when no root contains the package", () => {
    const empty = makeFakeGlobalRoot(dir, "empty-global");
    expect(resolveSmoltalkLlamaCppFromRoots([empty])).toBeNull();
  });
  it("tries roots in order and returns the first hit", () => {
    const rootA = makeFakeGlobalRoot(dir, "g-a");
    const rootB = makeFakeGlobalRoot(dir, "g-b");
    const entryB = plantFakePackage(rootB, "smoltalk-llama-cpp");
    expect(resolveSmoltalkLlamaCppFromRoots([rootA, rootB])).toBe(entryB);
  });
});

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
    for (const p of fakes.splice(0)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
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

describe("formatModelCatalog", () => {
  it("renders the curated models and has no trailing newline", () => {
    const out = formatModelCatalog();
    expect(out).toContain("smollm2-135m");
    expect(out.endsWith("\n")).toBe(false);
    // Blank lines separate models but never trail the block.
    expect(out.endsWith("")).toBe(true);
    expect(/\n\s*\n\s*$/.test(out)).toBe(false);
  });
});

describe("object-valued aliases", () => {
  it("resolves an object alias to its uri", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { foo: { uri: "hf:org/repo:Q4_K_M" } } } }),
    );
    expect(_resolveModelName("foo", aliasFile)).toBe("hf:org/repo:Q4_K_M");
  });

  it("resolves a string alias to its uri (back-compat shape)", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { bar: "hf:org/bar:Q4_K_M" } } }),
    );
    expect(_resolveModelName("bar", aliasFile)).toBe("hf:org/bar:Q4_K_M");
  });

  it("lists an object alias with its metadata and dedupes by name (alias wins)", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: {
          modelAliases: {
            "smollm2-135m": { uri: "hf:custom/smol:Q4_K_M", params: "999M", source: "remote" },
          },
        },
      }),
    );
    const entries = _listModelNames(aliasFile);
    const matches = entries.filter((e) => e.name === "smollm2-135m");
    expect(matches.length).toBe(1); // deduped: alias shadows the curated built-in
    expect(matches[0].target).toBe("hf:custom/smol:Q4_K_M");
    expect(matches[0].params).toBe("999M");
    expect(matches[0].source).toBe("alias");
  });
});

describe("formatModelCatalog with rich aliases", () => {
  it("renders a metadata-bearing alias in the table and a plain alias under ALIASES", () => {
    // Point alias resolution at a temp agency.json via cwd so the function
    // (which takes no file arg) picks it up.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      fs.writeFileSync(
        aliasFile,
        JSON.stringify({
          client: {
            modelAliases: {
              "rich-model": {
                uri: "hf:org/rich:Q4_K_M",
                params: "7B",
                sizeBytes: 4_000_000_000,
                category: "general",
                contextWindow: 131072,
                license: "apache-2.0",
                description: "A rich remote alias.",
                source: "remote",
              },
              "plain-model": "hf:org/plain:Q4_K_M",
            },
          },
        }),
      );
      const out = formatModelCatalog();
      // Rich alias is a table row (its params show up on the same line as its name).
      const richLine = out.split("\n").find((l) => l.includes("rich-model"));
      expect(richLine).toContain("7B");
      // Plain alias appears under ALIASES as name → uri, NOT as a table row.
      expect(out).toContain("plain-model → hf:org/plain:Q4_K_M");
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("resolveCatalogUrl", () => {
  afterEach(() => { delete process.env.AGENCY_MODEL_CATALOG_URL; });

  it("uses the explicit arg first", () => {
    expect(resolveCatalogUrl("https://x/y.json", aliasFile)).toBe("https://x/y.json");
  });
  it("falls back to the env var", () => {
    process.env.AGENCY_MODEL_CATALOG_URL = "https://env/c.json";
    expect(resolveCatalogUrl("", aliasFile)).toBe("https://env/c.json");
  });
  it("then the config, then the default", () => {
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { modelCatalogUrl: "https://cfg/c.json" } }));
    expect(resolveCatalogUrl("", aliasFile)).toBe("https://cfg/c.json");
    fs.writeFileSync(aliasFile, "{}");
    expect(resolveCatalogUrl("", aliasFile)).toContain("raw.githubusercontent.com/egonSchiele/agency-lang");
  });
});

describe("parseCatalog", () => {
  const good = JSON.stringify({
    version: 1,
    models: { "m1": { uri: "hf:org/m1:Q4_K_M", params: "2B", sizeBytes: 1, category: "general" } },
  });
  it("parses a valid catalog", () => {
    const out = parseCatalog(good);
    expect(out["m1"].uri).toBe("hf:org/m1:Q4_K_M");
    expect(out["m1"].params).toBe("2B");
  });
  it("throws on invalid JSON", () => {
    expect(() => parseCatalog("{not json")).toThrow(/valid JSON/);
  });
  it("throws on an unsupported version", () => {
    expect(() => parseCatalog(JSON.stringify({ version: 2, models: {} }))).toThrow(/version/);
  });
  it("throws when models is not an object", () => {
    expect(() => parseCatalog(JSON.stringify({ version: 1, models: [] }))).toThrow(/models/);
  });
  it("skips an entry with a bad uri but keeps the good ones", () => {
    const mixed = JSON.stringify({
      version: 1,
      models: { bad: { uri: "ftp://nope" }, good: { uri: "hf:org/g:Q4_K_M" } },
    });
    // Silence the expected `console.warn("[catalog] skipping …")` so the
    // suite output stays clean; also asserts the warn fires.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = parseCatalog(mixed);
      expect(out.bad).toBeUndefined();
      expect(out.good.uri).toBe("hf:org/g:Q4_K_M");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping "bad"'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("_refreshCatalog", () => {
  const blob = (models: Record<string, any>) => JSON.stringify({ version: 1, models });

  it("writes blob models as source:remote aliases and reports them added", async () => {
    fs.writeFileSync(aliasFile, "{}");
    const r = await _refreshCatalog({
      file: aliasFile,
      fetcher: async () => blob({ "qwen3.5-2b": { uri: "hf:org/q:Q4_K_M", params: "2B" } }),
    });
    expect(r.added).toEqual(["qwen3.5-2b"]);
    expect(r.modelCount).toBe(1); // total catalog entries
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases["qwen3.5-2b"]).toEqual({
      uri: "hf:org/q:Q4_K_M", params: "2B", source: "remote",
    });
  });

  it("skips a name that collides with a user alias; modelCount still counts the entry", async () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { "qwen3.5-2b": "hf:mine/custom:Q4_K_M" } } }),
    );
    const r = await _refreshCatalog({
      file: aliasFile,
      fetcher: async () => blob({ "qwen3.5-2b": { uri: "hf:org/remote:Q4_K_M" } }),
    });
    expect(r.skipped).toEqual([
      { name: "qwen3.5-2b", keptUri: "hf:mine/custom:Q4_K_M", remoteUri: "hf:org/remote:Q4_K_M" },
    ]);
    expect(r.added).toEqual([]);
    expect(r.modelCount).toBe(1); // catalog had 1 entry, even though we skipped it
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases["qwen3.5-2b"]).toBe("hf:mine/custom:Q4_K_M");
  });

  it("classifies re-runs: unchanged when value matches, updated when it differs, removed when absent", async () => {
    fs.writeFileSync(aliasFile, "{}");
    // First run: seed two managed entries.
    await _refreshCatalog({
      file: aliasFile,
      fetcher: async () => blob({
        a: { uri: "hf:org/a:Q4_K_M", params: "1B" },
        b: { uri: "hf:org/b:Q4_K_M" },
      }),
    });
    // Second run: `a` unchanged, `b` dropped, `c` added with same-uri but no
    // metadata change vs first run (it's new — `added`), and `a` gets a new
    // params value (this is the actual `updated` case).
    const r = await _refreshCatalog({
      file: aliasFile,
      fetcher: async () => blob({
        a: { uri: "hf:org/a:Q4_K_M", params: "2B" }, // metadata changed
        c: { uri: "hf:org/c:Q4_K_M" },               // new
      }),
    });
    expect(r.added).toEqual(["c"]);
    expect(r.updated).toEqual(["a"]);
    expect(r.unchanged).toEqual([]);
    expect(r.removed).toEqual(["b"]);
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases.b).toBeUndefined();
    expect(cfg.client.modelAliases.a.params).toBe("2B");
  });

  it("reports unchanged when a re-run writes a byte-identical value", async () => {
    fs.writeFileSync(aliasFile, "{}");
    const fetcher = async () => blob({ a: { uri: "hf:org/a:Q4_K_M", params: "1B" } });
    await _refreshCatalog({ file: aliasFile, fetcher });
    const r = await _refreshCatalog({ file: aliasFile, fetcher });
    expect(r.added).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.unchanged).toEqual(["a"]);
    expect(r.removed).toEqual([]);
  });

  it("leaves agency.json untouched when the blob is invalid", async () => {
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { modelAliases: { keep: "hf:k:Q4_K_M" } } }));
    await expect(
      _refreshCatalog({ file: aliasFile, fetcher: async () => "{not json" }),
    ).rejects.toThrow(/valid JSON/);
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases.keep).toBe("hf:k:Q4_K_M");
  });
});
