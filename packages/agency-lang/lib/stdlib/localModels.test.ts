import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileTarget } from "../config/target.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "node:crypto";
import { startFakeHub } from "./__tests__/fakeHub.js";
import { readMlxModelRecord, isMlxModelComplete } from "./mlxModelRecord.js";
import {
  CURATED_LOCAL_MODELS,
  _resolveModelName,
  configuredDownloadConcurrency,
  _listModelNames,
  _aliasModel,
  _unaliasModel,
  _listDownloadedModels,
  _findDownloadedServedModel,
  hubSnapshotDir,
  hubRepoOfDirName,
  type DownloadedModel,
  _removeModel,
  _localModelsSupported,
  resolveAliasConfigPath,
  type ModelNameEntry,
  resolveCatalogUrl,
  parseCatalog,
  _refreshCatalog,
  fileSha256,
  verifyModelFile,
  pinnedSha256,
  backendOfTarget,
  _resolveModel,
  _catalogKind,
  kindOfCategory,
  tagsOfCategory,
  _removeServedModel,
  isMlxUri,
  parseMlxUri,
  isServedUri,
  parseServedUri,
  isModelDir,
  isDiffusersDir,
  modelDirEntries,
  _modelFilesOnDisk,
} from "./localModels.js";
import { formatModelCatalog, formatLocalList } from "./localModelList.js";

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
    expect(_resolveModelName("/x/y.gguf", fileTarget(aliasFile))).toBe("/x/y.gguf");
    expect(_resolveModelName("hf:org/repo:Q4", fileTarget(aliasFile))).toBe("hf:org/repo:Q4");
  });
  it("maps a curated short name to its uri", () => {
    const k = Object.keys(CURATED_LOCAL_MODELS)[0];
    expect(_resolveModelName(k, fileTarget(aliasFile))).toBe(CURATED_LOCAL_MODELS[k].uri);
  });
  it("throws listing known names for an unknown one", () => {
    expect(() => _resolveModelName("nope", fileTarget(aliasFile))).toThrow(
      /Unknown local model "nope"/,
    );
  });
  it("user alias overrides a curated short name with the same key", () => {
    fs.writeFileSync(aliasFile, "{}");
    const curatedKey = Object.keys(CURATED_LOCAL_MODELS)[0];
    _aliasModel(curatedKey, "hf:custom/override:Q4", fileTarget(aliasFile));
    expect(_resolveModelName(curatedKey, fileTarget(aliasFile))).toBe("hf:custom/override:Q4");
  });
});

describe("curated catalog shape", () => {
  it("every entry has a non-empty uri, params, description, a kind, and tags", () => {
    const validKinds = new Set(["chat", "embedding", "speech", "image", "vision"]);
    const validTags = new Set(["coding", "reasoning", "writing", "science", "uncensored"]);
    // Curated set is permissive-licensed only.
    const permissiveLicenses = new Set(["apache-2.0", "mit"]);
    for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
      expect(info.uri, `${name}.uri`).toMatch(/^(hf|mlx|diffusers):/);
      expect(info.backend, `${name}.backend`).toBe(backendOfTarget(info.uri));
      expect(info.params.length, `${name}.params`).toBeGreaterThan(0);
      expect(info.description.length, `${name}.description`).toBeGreaterThan(0);
      expect(info.sizeBytes, `${name}.sizeBytes`).toBeGreaterThan(0);
      expect(info.contextWindow, `${name}.contextWindow`).toBeGreaterThan(0);
      expect(validKinds.has(info.kind), `${name}.kind=${info.kind}`).toBe(true);
      for (const tag of info.tags) {
        expect(validTags.has(tag), `${name}.tags has ${tag}`).toBe(true);
      }
      // Only a chat model is good for something in particular.
      if (info.kind !== "chat") {
        expect(info.tags, `${name}.tags`).toEqual([]);
      }
      expect(permissiveLicenses.has(info.license), `${name}.license=${info.license}`).toBe(true);
    }
  });
  it("smollm2-135m is present (integration suite depends on it)", () => {
    expect(CURATED_LOCAL_MODELS["smollm2-135m"]).toBeDefined();
    expect(CURATED_LOCAL_MODELS["smollm2-135m"].kind).toBe("chat");
    expect(CURATED_LOCAL_MODELS["smollm2-135m"].tags).toEqual([]);
  });
  it("the Qwen3-TTS entries are speech models, resolving to their mlx: URIs", () => {
    expect(_catalogKind("qwen3-tts-mlx")).toBe("speech");
    expect(_catalogKind("qwen3-tts-design-mlx")).toBe("speech");
    expect(_resolveModel("qwen3-tts-mlx").target).toBe(
      "mlx:mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
    );
    expect(_resolveModel("qwen3-tts-design-mlx").target).toBe(
      "mlx:mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit",
    );
  });
  it("orpheus-3b-mlx is a speech model with the SNAC decoder as its companion", () => {
    expect(_catalogKind("orpheus-3b-mlx")).toBe("speech");
    expect(CURATED_LOCAL_MODELS["orpheus-3b-mlx"].companions).toEqual([
      "mlx:mlx-community/snac_24khz",
    ]);
    for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
      for (const companion of info.companions ?? []) {
        expect(companion, `${name}.companions`).toMatch(/^mlx:/);
      }
    }
  });
});

describe("aliases", () => {
  it("add → resolve → list → remove round-trips via the provided file", () => {
    fs.writeFileSync(aliasFile, "{}");
    const file = _aliasModel("my7b", "hf:org/repo:Q4_K_M", fileTarget(aliasFile));
    expect(file).toBe(aliasFile);
    expect(_resolveModelName("my7b", fileTarget(aliasFile))).toBe("hf:org/repo:Q4_K_M");
    expect(_listModelNames(fileTarget(aliasFile))).toContainEqual({
      name: "my7b",
      backend: "llama-cpp",
      target: "hf:org/repo:Q4_K_M",
      source: "alias",
    });
    _unaliasModel("my7b", fileTarget(aliasFile));
    expect(() => _resolveModelName("my7b", fileTarget(aliasFile))).toThrow();
  });
  it("preserves other config fields when writing", () => {
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { defaultModel: "gpt-4o-mini" } }));
    _aliasModel("a", "hf:x/y:Q4", fileTarget(aliasFile));
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf-8"));
    expect(cfg.client.defaultModel).toBe("gpt-4o-mini");
    expect(cfg.client.modelAliases.a).toBe("hf:x/y:Q4");
  });
  it("unaliasModel bails early when the file or alias is missing (no write)", () => {
    const r1 = _unaliasModel("ghost", fileTarget(aliasFile));
    expect(r1).toEqual({ file: aliasFile, removed: false });
    expect(fs.existsSync(aliasFile)).toBe(false);
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { defaultModel: "x" } }, null, 2));
    const before = fs.readFileSync(aliasFile, "utf-8");
    const r2 = _unaliasModel("ghost", fileTarget(aliasFile));
    expect(r2).toEqual({ file: aliasFile, removed: false });
    expect(fs.readFileSync(aliasFile, "utf-8")).toBe(before);
  });
  it("unaliasModel returns { removed: true } when the alias was actually written out", () => {
    fs.writeFileSync(aliasFile, "{}");
    _aliasModel("toRemove", "hf:x/y:Q4", fileTarget(aliasFile));
    expect(_unaliasModel("toRemove", fileTarget(aliasFile))).toEqual({
      file: aliasFile,
      removed: true,
    });
    // Idempotent: a second remove is a no-op and reports removed=false.
    expect(_unaliasModel("toRemove", fileTarget(aliasFile))).toEqual({
      file: aliasFile,
      removed: false,
    });
  });
});

describe("configuredDownloadConcurrency", () => {
  it("defaults to 8, takes a positive integer, and refuses anything else", () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(configuredDownloadConcurrency()).toBe(8);
      fs.writeFileSync(aliasFile, JSON.stringify({ client: { mlx: { downloadConcurrency: 3 } } }));
      expect(configuredDownloadConcurrency()).toBe(3);
      for (const bad of ["bad", 0, -1, 2.5]) {
        fs.writeFileSync(
          aliasFile,
          JSON.stringify({ client: { mlx: { downloadConcurrency: bad } } }),
        );
        expect(() => configuredDownloadConcurrency()).toThrow(
          new RegExp(`Invalid config in ${aliasFile}[\\s\\S]*client\\.mlx\\.downloadConcurrency`),
        );
      }
    } finally {
      process.chdir(cwd);
    }
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
  it("hides a symlinked model and refuses a name that leaves the cache dir", () => {
    const cache = path.join(dir, "models");
    const outside = path.join(dir, "outside.gguf");
    fs.mkdirSync(cache);
    fs.writeFileSync(outside, "xxxx");
    fs.symlinkSync(outside, path.join(cache, "linked.gguf"));
    expect(_listDownloadedModels(cache)).toEqual([]);
    expect(_removeModel("linked.gguf", cache)).toBe(false);
    expect(() => _removeModel("../outside.gguf", cache)).toThrow();
    expect(fs.existsSync(outside)).toBe(true);
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

// The global-install discovery tests moved to lib/runtime/localProvider.test.ts
// with the probe functions themselves.

import {
  _registerLocalProvider,
  _downloadModel,
  _registerLocalModel,
  _resolveLocalEmbeddingModel,
} from "./localModels.js";
import { readDownloadManifest } from "./localModelManifest.js";
import * as smoltalkPkg from "smoltalk";

describe("provider register + download (fake plugin module)", () => {
  const here2 = import.meta.dirname;
  const fakes: string[] = [];
  // Plugin-shaped, matching what smoltalk's loadLlamaCpp validates: a
  // LlamaCPP class export + resolveModel. Same path every time — smoltalk
  // caches the loaded module per process anyway, so the content must be
  // identical across tests (it is).
  function fakeModule(): string {
    const p = path.join(here2, "__tmp_fakellama.mjs");
    fs.writeFileSync(
      p,
      `import { BaseClient } from "smoltalk";
      import * as fs from "node:fs";
      import * as path from "node:path";
      export class LlamaCPP extends BaseClient { async textSync() { return { success: true, value: { output: "x", toolCalls: [] } }; } }
      export async function resolveModel(target, dir) {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "model.gguf");
        fs.writeFileSync(file, "FAKE:" + target);
        return file;
      }`,
    );
    fakes.push(p);
    return p;
  }
  afterEach(() => {
    for (const p of fakes.splice(0)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    delete process.env.AGENCY_LLAMA_PROVIDER_MODULE;
    smoltalkPkg.unregisterProvider("llama-cpp");
  });

  it("registers the provider", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    await _registerLocalProvider();
    expect(smoltalkPkg.getClient({ model: "m", provider: "llama-cpp" }).constructor.name).toBe(
      "LlamaCPP",
    );
  });
  it("downloads (resolves) a uri to a real path and records it in the manifest", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    const out = await _downloadModel("hf:org/repo:Q4", dir); // raw uri → no pin
    expect(out).toBe(path.join(dir, "model.gguf"));
    expect(fs.existsSync(out)).toBe(true);
    expect(readDownloadManifest(dir)).toEqual({ "hf:org/repo:Q4": "model.gguf" });
  });
  it("registerLocalModel registers and returns the resolved path", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    const out = await _registerLocalModel("/abs/my.gguf", dir); // raw path → no pin
    expect(out).toBe(path.join(dir, "model.gguf"));
    expect(smoltalkPkg.getClient({ model: "m", provider: "llama-cpp" }).constructor.name).toBe(
      "LlamaCPP",
    );
  });

  it("_resolveLocalEmbeddingModel registers the provider for a .gguf path and serves mlx names", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    expect(await _resolveLocalEmbeddingModel("llama-cpp", "/abs/emb.gguf")).toBe("/abs/emb.gguf");
    expect(smoltalkPkg.getClient({ model: "m", provider: "llama-cpp" }).constructor.name).toBe(
      "LlamaCPP",
    );
    expect(await _resolveLocalEmbeddingModel("mlx", "qwen3-embedding-4b-mlx")).toBe(
      "mlx-community/Qwen3-Embedding-4B-4bit-DWQ",
    );
    expect(await _resolveLocalEmbeddingModel("mlx", "mlx-community/Other-4bit")).toBe(
      "mlx-community/Other-4bit",
    );
  });

  it("verifies a freshly-downloaded pinned model (match → ok)", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    const target = "hf:org/x:Q4";
    const sha = createHash("sha256")
      .update("FAKE:" + target)
      .digest("hex");
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: { modelAliases: { mymodel: { backend: "llama-cpp", uri: target, sha256: sha } } },
      }),
    );
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const out = await _downloadModel("mymodel", dir);
      expect(fs.existsSync(out)).toBe(true);
      expect(fs.existsSync(out + ".invalidSha")).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("quarantines a freshly-downloaded model whose hash is wrong", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: {
          modelAliases: {
            mymodel: { backend: "llama-cpp", uri: "hf:org/x:Q4", sha256: "0".repeat(64) },
          },
        },
      }),
    );
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(_downloadModel("mymodel", dir)).rejects.toThrow(/SHA-256 verification failed/);
      expect(fs.existsSync(path.join(dir, "model.gguf"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "model.gguf.invalidSha"))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("does NOT re-verify an already-present (cache-hit) file", async () => {
    process.env.AGENCY_LLAMA_PROVIDER_MODULE = fakeModule();
    // Pre-create the model file so it's in the before-snapshot → treated as cached.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.gguf"), "pre-existing");
    // A deliberately-wrong pin would fail IF it verified — it must be skipped.
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: {
          modelAliases: {
            mymodel: { backend: "llama-cpp", uri: "hf:org/x:Q4", sha256: "0".repeat(64) },
          },
        },
      }),
    );
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(_downloadModel("mymodel", dir)).resolves.toBe(path.join(dir, "model.gguf"));
      expect(fs.existsSync(path.join(dir, "model.gguf.invalidSha"))).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("formatLocalList", () => {
  const entries: ModelNameEntry[] = [
    {
      name: "tiny",
      backend: "llama-cpp",
      target: "hf:o/tiny:Q4",
      source: "curated",
      params: "135M",
      sizeBytes: 100_000_000,
      contextWindow: 8192,
      license: "apache-2.0",
    },
    {
      name: "mid",
      backend: "llama-cpp",
      target: "hf:o/mid:Q4",
      source: "curated",
      params: "2B",
      sizeBytes: 1_200_000_000,
      contextWindow: 131072,
      license: "apache-2.0",
      description: "A middling model.",
    },
  ];

  it("marks a pinned MLX row downloaded when any copy is at that revision", () => {
    const pinned: ModelNameEntry[] = [
      {
        name: "pinned-mlx",
        backend: "mlx",
        target: "mlx:org/repo@aaa111",
        source: "curated",
        sizeBytes: 10,
        license: "apache-2.0",
      },
    ];
    const copy = (revision: string, layout: "agency" | "hub"): DownloadedModel => ({
      name: "org/repo",
      path: `/x/${layout}/${revision}`,
      sizeBytes: 10,
      backend: "mlx",
      complete: true,
      revision,
      layout,
    });
    // The Hub copy is at another revision, and comes last in the list. The
    // Agency copy is the one the pin names.
    const out = formatLocalList({
      dir: "/models",
      entries: pinned,
      manifest: {},
      files: [copy("aaa111", "agency"), copy("bbb222", "hub")],
    });
    expect(out).toContain("✓  pinned-mlx");
  });

  it("marks manifest-and-file-backed entries as downloaded; first line names the dir", () => {
    const out = formatLocalList({
      dir: "/home/u/.agency-agent/models",
      entries,
      manifest: { "hf:o/tiny:Q4": "tiny.Q4.gguf" },
      files: [
        {
          name: "tiny.Q4.gguf",
          path: "/x/tiny.Q4.gguf",
          sizeBytes: 99_000_000,
          backend: "llama-cpp",
          complete: true,
        },
      ],
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("Models directory: /home/u/.agency-agent/models");
    const tinyLine = lines.find((l) => l.includes("tiny"));
    const midLine = lines.find((l) => l.includes("mid"));
    expect(tinyLine).toContain("✓");
    expect(midLine).not.toContain("✓");
    expect(out).toContain("Total downloaded: 0.10 GB");
    expect(out).not.toContain("OTHER FILES");
  });

  it("stale manifest entry (file gone) is not marked; unmatched files land in OTHER FILES", () => {
    const out = formatLocalList({
      dir: "/d",
      entries,
      manifest: { "hf:o/tiny:Q4": "gone.gguf" },
      files: [
        {
          name: "mystery.gguf",
          path: "/d/mystery.gguf",
          sizeBytes: 2_100_000_000,
          backend: "llama-cpp",
          complete: true,
        },
      ],
    });
    expect(out.split("\n").find((l) => l.includes("tiny"))).not.toContain("✓");
    expect(out).toContain("OTHER FILES");
    expect(out).toContain("mystery.gguf");
    expect(out).toContain("2.10 GB");
  });

  it("raw-URI downloads (in the manifest but not the catalog) stay visible in OTHER FILES", () => {
    const out = formatLocalList({
      dir: "/d",
      entries,
      manifest: { "hf:raw/repo:Q4": "raw.gguf" },
      files: [
        {
          name: "raw.gguf",
          path: "/d/raw.gguf",
          sizeBytes: 500_000_000,
          backend: "llama-cpp",
          complete: true,
        },
      ],
    });
    expect(out).toContain("OTHER FILES");
    expect(out).toContain("raw.gguf");
  });

  it("omits descriptions by default", () => {
    const out = formatLocalList({ dir: "/d", entries, manifest: {}, files: [] });
    expect(out).not.toContain("A middling model.");
  });

  it("long mode puts the description on its own line below its model", () => {
    const out = formatLocalList({ dir: "/d", entries, manifest: {}, files: [], long: true });
    const lines = out.split("\n");
    const midAt = lines.findIndex((l) => l.includes("mid"));
    expect(lines[midAt + 1]).toContain("A middling model.");
    // The description gets a line to itself, not a table column.
    expect(lines[midAt]).not.toContain("A middling model.");
    // Blank line BETWEEN models: "tiny" has no description, so the blank
    // before "mid" is the separator, not a leftover from a description line.
    expect(lines[midAt - 1]).toBe("");
  });

  it("long mode does not double-space the section that follows the table", () => {
    const out = formatLocalList({
      dir: "/d",
      entries,
      manifest: {},
      files: [
        {
          name: "raw.gguf",
          path: "/d/raw.gguf",
          sizeBytes: 500_000_000,
          backend: "llama-cpp",
          complete: true,
        },
      ],
      long: true,
    });
    const lines = out.split("\n");
    const othersAt = lines.indexOf("OTHER FILES");
    expect(othersAt).toBeGreaterThan(0);
    // Exactly one blank line separates the last model from OTHER FILES.
    expect(lines[othersAt - 1]).toBe("");
    expect(lines[othersAt - 2]).not.toBe("");
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
      JSON.stringify({
        client: { modelAliases: { foo: { backend: "llama-cpp", uri: "hf:org/repo:Q4_K_M" } } },
      }),
    );
    expect(_resolveModelName("foo", fileTarget(aliasFile))).toBe("hf:org/repo:Q4_K_M");
  });

  it("resolves a string alias to its uri (back-compat shape)", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { bar: "hf:org/bar:Q4_K_M" } } }),
    );
    expect(_resolveModelName("bar", fileTarget(aliasFile))).toBe("hf:org/bar:Q4_K_M");
  });

  it("lists an object alias with its metadata and dedupes by name (alias wins)", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: {
          modelAliases: {
            "smollm2-135m": {
              backend: "llama-cpp",
              uri: "hf:custom/smol:Q4_K_M",
              params: "999M",
              source: "remote",
            },
          },
        },
      }),
    );
    const entries = _listModelNames(fileTarget(aliasFile));
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
                backend: "llama-cpp",
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
  afterEach(() => {
    delete process.env.AGENCY_MODEL_CATALOG_URL;
  });

  it("uses the explicit arg first", () => {
    expect(resolveCatalogUrl("https://x/y.json", fileTarget(aliasFile))).toBe("https://x/y.json");
  });
  it("falls back to the env var", () => {
    process.env.AGENCY_MODEL_CATALOG_URL = "https://env/c.json";
    expect(resolveCatalogUrl("", fileTarget(aliasFile))).toBe("https://env/c.json");
  });
  it("then the config, then the default", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelCatalogUrl: "https://cfg/c.json" } }),
    );
    expect(resolveCatalogUrl("", fileTarget(aliasFile))).toBe("https://cfg/c.json");
    fs.writeFileSync(aliasFile, "{}");
    expect(resolveCatalogUrl("", fileTarget(aliasFile))).toContain(
      "raw.githubusercontent.com/egonSchiele/agency-lang",
    );
  });
});

describe("parseCatalog", () => {
  const good = JSON.stringify({
    version: 1,
    models: {
      m1: {
        backend: "llama-cpp",
        uri: "hf:org/m1:Q4_K_M",
        params: "2B",
        sizeBytes: 1,
        category: "general",
      },
    },
  });
  it("parses a valid catalog", () => {
    const out = parseCatalog(good);
    expect(out["m1"].uri).toBe("hf:org/m1:Q4_K_M");
    expect(out["m1"].params).toBe("2B");
  });
  it("keeps companions, so a refreshed model can still fetch what it loads by name", () => {
    const withCompanions = JSON.stringify({
      version: 1,
      models: {
        m2: {
          backend: "mlx",
          uri: "mlx:org/m2",
          companions: ["mlx:org/decoder"],
        },
        m3: {
          backend: "mlx",
          uri: "mlx:org/m3",
          // Not an mlx: URI, so the field is dropped and the entry kept.
          companions: ["hf:org/decoder:Q4_K_M"],
        },
      },
    });
    const out = parseCatalog(withCompanions);
    expect(out["m2"].companions).toEqual(["mlx:org/decoder"]);
    expect(out["m3"].companions).toBeUndefined();
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
      models: {
        bad: { uri: "ftp://nope" },
        good: { backend: "llama-cpp", uri: "hf:org/g:Q4_K_M" },
      },
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

  it("rejects an http: uri (insecure) but accepts hf:/https:/.gguf", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = parseCatalog(
        JSON.stringify({
          version: 1,
          models: {
            insecure: { uri: "http://example.com/m.gguf" },
            secureHttps: { backend: "llama-cpp", uri: "https://example.com/m.gguf" },
            hf: { backend: "llama-cpp", uri: "hf:org/m:Q4_K_M" },
            gguf: { backend: "llama-cpp", uri: "/abs/path/m.gguf" },
          },
        }),
      );
      expect(out.insecure).toBeUndefined();
      expect(out.secureHttps.uri).toBe("https://example.com/m.gguf");
      expect(out.hf.uri).toBe("hf:org/m:Q4_K_M");
      expect(out.gguf.uri).toBe("/abs/path/m.gguf");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping "insecure"'));
    } finally {
      warn.mockRestore();
    }
  });

  it("drops a wrongly-typed metadata field but keeps the entry (lenient)", () => {
    const out = parseCatalog(
      JSON.stringify({
        version: 1,
        models: {
          m: { backend: "llama-cpp", uri: "hf:org/m:Q4_K_M", params: 7, sizeBytes: "big" },
        },
      }),
    );
    expect(out.m.uri).toBe("hf:org/m:Q4_K_M");
    expect(out.m.params).toBeUndefined(); // 7 is not a string → dropped
    expect(out.m.sizeBytes).toBeUndefined(); // "big" is not a number → dropped
  });

  it("keeps a valid 64-hex sha256 (lowercased) and drops malformed ones", () => {
    const upper = "A".repeat(64);
    const out = parseCatalog(
      JSON.stringify({
        version: 1,
        models: {
          good: { backend: "llama-cpp", uri: "hf:org/g:Q4_K_M", sha256: upper },
          tooShort: { backend: "llama-cpp", uri: "hf:org/s:Q4_K_M", sha256: "abc123" },
          notString: { backend: "llama-cpp", uri: "hf:org/n:Q4_K_M", sha256: 123 },
        },
      }),
    );
    expect(out.good.sha256).toBe("a".repeat(64)); // valid → normalized lowercase, entry kept
    expect(out.tooShort.sha256).toBeUndefined(); // not 64-hex → dropped, entry kept
    expect(out.notString.sha256).toBeUndefined(); // wrong type → dropped, entry kept
  });
});

describe("_refreshCatalog", () => {
  const blob = (models: Record<string, any>) => JSON.stringify({ version: 1, models });

  it("writes blob models as source:remote aliases and reports them added", async () => {
    fs.writeFileSync(aliasFile, "{}");
    const r = await _refreshCatalog({
      target: fileTarget(aliasFile),
      fetcher: async () =>
        blob({ "qwen3.5-2b": { backend: "llama-cpp", uri: "hf:org/q:Q4_K_M", params: "2B" } }),
    });
    expect(r.added).toEqual(["qwen3.5-2b"]);
    expect(r.modelCount).toBe(1); // total catalog entries
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases["qwen3.5-2b"]).toEqual({
      backend: "llama-cpp",
      uri: "hf:org/q:Q4_K_M",
      params: "2B",
      source: "remote",
    });
  });

  it("skips a name that collides with a user alias; modelCount still counts the entry", async () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { "qwen3.5-2b": "hf:mine/custom:Q4_K_M" } } }),
    );
    const r = await _refreshCatalog({
      target: fileTarget(aliasFile),
      fetcher: async () =>
        blob({ "qwen3.5-2b": { backend: "llama-cpp", uri: "hf:org/remote:Q4_K_M" } }),
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
      target: fileTarget(aliasFile),
      fetcher: async () =>
        blob({
          a: { backend: "llama-cpp", uri: "hf:org/a:Q4_K_M", params: "1B" },
          b: { backend: "llama-cpp", uri: "hf:org/b:Q4_K_M" },
        }),
    });
    // Second run: `a` unchanged, `b` dropped, `c` added with same-uri but no
    // metadata change vs first run (it's new — `added`), and `a` gets a new
    // params value (this is the actual `updated` case).
    const r = await _refreshCatalog({
      target: fileTarget(aliasFile),
      fetcher: async () =>
        blob({
          a: { backend: "llama-cpp", uri: "hf:org/a:Q4_K_M", params: "2B" }, // metadata changed
          c: { backend: "llama-cpp", uri: "hf:org/c:Q4_K_M" }, // new
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
    const fetcher = async () =>
      blob({ a: { backend: "llama-cpp", uri: "hf:org/a:Q4_K_M", params: "1B" } });
    await _refreshCatalog({ target: fileTarget(aliasFile), fetcher });
    const r = await _refreshCatalog({ target: fileTarget(aliasFile), fetcher });
    expect(r.added).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.unchanged).toEqual(["a"]);
    expect(r.removed).toEqual([]);
  });

  it("leaves agency.json untouched when the blob is invalid", async () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { keep: "hf:k:Q4_K_M" } } }),
    );
    await expect(
      _refreshCatalog({ target: fileTarget(aliasFile), fetcher: async () => "{not json" }),
    ).rejects.toThrow(/valid JSON/);
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases.keep).toBe("hf:k:Q4_K_M");
  });

  it("writes the catalog sha256 into the remote alias", async () => {
    const sha = "deadbeef".repeat(8); // a valid 64-hex sha256
    fs.writeFileSync(aliasFile, "{}");
    await _refreshCatalog({
      target: fileTarget(aliasFile),
      fetcher: async () =>
        JSON.stringify({
          version: 1,
          models: { m: { backend: "llama-cpp", uri: "hf:org/m:Q4_K_M", sha256: sha } },
        }),
    });
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases.m.sha256).toBe(sha);
  });

  it("does not treat a prototype-named model as a user collision", async () => {
    fs.writeFileSync(aliasFile, "{}");
    // "toString" exists on Object.prototype, so a naive `name in userAliases`
    // would falsely report a collision. With own-property checks it's added.
    const r = await _refreshCatalog({
      target: fileTarget(aliasFile),
      fetcher: async () => blob({ toString: { backend: "llama-cpp", uri: "hf:org/ts:Q4_K_M" } }),
    });
    expect(r.added).toEqual(["toString"]);
    expect(r.skipped).toEqual([]);
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases.toString.uri).toBe("hf:org/ts:Q4_K_M");
  });

  it("reads the catalog from a local file path via the default fetcher (no network)", async () => {
    // Integration-ish: exercises the real fetchCatalog file branch + parse +
    // merge, with no fetcher injected and no HTTP.
    fs.writeFileSync(aliasFile, "{}");
    const catalogPath = path.join(dir, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        version: 1,
        models: { m: { backend: "llama-cpp", uri: "hf:org/m:Q4_K_M", params: "2B" } },
      }),
    );
    const r = await _refreshCatalog({ url: catalogPath, target: fileTarget(aliasFile) });
    expect(r.added).toEqual(["m"]);
    const cfg = JSON.parse(fs.readFileSync(aliasFile, "utf8"));
    expect(cfg.client.modelAliases.m).toEqual({
      backend: "llama-cpp",
      uri: "hf:org/m:Q4_K_M",
      params: "2B",
      source: "remote",
    });
  });
});

describe("model file verification", () => {
  it("fileSha256 matches node:crypto over the same bytes", async () => {
    const p = path.join(dir, "m.gguf");
    fs.writeFileSync(p, "hello-bytes");
    const expected = createHash("sha256").update("hello-bytes").digest("hex");
    expect(await fileSha256(p)).toBe(expected);
  });

  it("verifyModelFile resolves on a match", async () => {
    const p = path.join(dir, "m.gguf");
    fs.writeFileSync(p, "good");
    const sha = createHash("sha256").update("good").digest("hex");
    await expect(verifyModelFile(p, sha, "m")).resolves.toBeUndefined();
    expect(fs.existsSync(p)).toBe(true); // left in place
  });

  it("verifyModelFile matches an uppercase expected hash (case-insensitive)", async () => {
    const p = path.join(dir, "m.gguf");
    fs.writeFileSync(p, "good");
    const sha = createHash("sha256").update("good").digest("hex").toUpperCase();
    await expect(verifyModelFile(p, sha, "m")).resolves.toBeUndefined();
    expect(fs.existsSync(p)).toBe(true);
  });

  it("verifyModelFile quarantines + throws on a mismatch", async () => {
    const p = path.join(dir, "m.gguf");
    fs.writeFileSync(p, "tampered");
    await expect(verifyModelFile(p, "0".repeat(64), "m")).rejects.toThrow(
      /SHA-256 verification failed/,
    );
    expect(fs.existsSync(p)).toBe(false); // moved aside
    expect(fs.existsSync(p + ".invalidSha")).toBe(true); // kept for inspection
  });

  it("pinnedSha256: curated, alias-object wins, string-alias + raw → undefined", () => {
    const k = Object.keys(CURATED_LOCAL_MODELS)[0];
    // Curated lookup mirrors the curated entry's sha256 — undefined before the
    // Task 4 pins are added, hex after; this assertion holds in both states.
    expect(pinnedSha256(k, fileTarget(aliasFile))).toBe(CURATED_LOCAL_MODELS[k].sha256);
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: {
          modelAliases: {
            obj: { backend: "llama-cpp", uri: "hf:o/x:Q4", sha256: "aa" },
            str: "hf:o/y:Q4",
          },
        },
      }),
    );
    expect(pinnedSha256("obj", fileTarget(aliasFile))).toBe("aa"); // alias object hash
    expect(pinnedSha256("str", fileTarget(aliasFile))).toBeUndefined(); // string alias has none
    expect(pinnedSha256("hf:o/z:Q4", fileTarget(aliasFile))).toBeUndefined(); // raw uri
    expect(pinnedSha256("/abs/x.gguf", fileTarget(aliasFile))).toBeUndefined(); // raw path
  });

  it("pinnedSha256: a user alias shadowing a curated name uses the alias (not curated)", () => {
    const k = Object.keys(CURATED_LOCAL_MODELS)[0];
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { [k]: "hf:mine/custom:Q4" } } }),
    );
    // string alias governs → no pin (must NOT fall back to the curated hash)
    expect(pinnedSha256(k, fileTarget(aliasFile))).toBeUndefined();
  });
});

describe("backend of a target", () => {
  it("hf: URIs and .gguf paths are llama-cpp", () => {
    expect(backendOfTarget("hf:org/repo:Q4_K_M")).toBe("llama-cpp");
    expect(backendOfTarget("/models/x.gguf")).toBe("llama-cpp");
  });

  it("mlx: URIs are mlx, with and without a revision", () => {
    expect(isMlxUri("mlx:mlx-community/Qwen3-Coder-Next-4bit")).toBe(true);
    expect(parseMlxUri("mlx:mlx-community/Qwen3-Coder-Next-4bit")).toEqual({
      repo: "mlx-community/Qwen3-Coder-Next-4bit",
      revision: undefined,
    });
    expect(parseMlxUri("mlx:mlx-community/Qwen3-Coder-Next-4bit@7b9321e")).toEqual({
      repo: "mlx-community/Qwen3-Coder-Next-4bit",
      revision: "7b9321e",
    });
    for (const bad of [
      "mlx:..\\escape/repo",
      "mlx:org/re po",
      "mlx:org/repo/extra",
      "mlx:org",
      "mlx:../repo",
      "mlx:org/..",
      "mlx:org/repo@..",
      "mlx:./repo",
    ]) {
      expect(isMlxUri(bad)).toBe(false);
      expect(() => parseMlxUri(bad)).toThrow(/is not an mlx: URI/);
    }
    expect(backendOfTarget("mlx:mlx-community/Qwen3-Coder-Next-4bit")).toBe("mlx");
    expect(() => parseMlxUri("mlx:no-slash")).toThrow(/is not an mlx: URI/);
  });

  it("a directory with config.json and a safetensors file is an mlx model", () => {
    const model = path.join(dir, "m");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    expect(isModelDir(model)).toBe(false);
    fs.writeFileSync(path.join(model, "model.safetensors"), "");
    expect(isModelDir(model)).toBe(true);
    expect(backendOfTarget(model)).toBe("mlx");
  });

  it("a Hugging Face cache snapshot, whose entries are symlinks, is an mlx model", () => {
    // hf/hub/models--org--repo/{blobs,snapshots/<sha>}: every entry in the
    // snapshot is a link into blobs/. Sizes come from the blobs.
    const blobs = path.join(dir, "blobs");
    const snapshot = path.join(dir, "snapshots", "abc");
    fs.mkdirSync(blobs);
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(blobs, "c0"), "{}");
    fs.writeFileSync(path.join(blobs, "w0"), Buffer.alloc(1000));
    fs.symlinkSync("../../blobs/c0", path.join(snapshot, "config.json"));
    fs.symlinkSync("../../blobs/w0", path.join(snapshot, "model.safetensors"));
    expect(isModelDir(snapshot)).toBe(true);
    expect(modelDirEntries(snapshot)).toEqual([
      { name: "config.json", size: 2 },
      { name: "model.safetensors", size: 1000 },
    ]);
    expect(_modelFilesOnDisk({ backend: "mlx", target: snapshot }, dir)).toEqual({
      path: snapshot,
      sizeBytes: 1002,
      insideCache: false,
      // Not under a `models--org--repo` folder, so it is just a directory.
      layout: "directory",
    });
  });

  it("a dangling link in a model directory is skipped", () => {
    const model = path.join(dir, "m");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.symlinkSync(path.join(dir, "gone"), path.join(model, "model.safetensors"));
    expect(isModelDir(model)).toBe(false);
  });

  it("a path that is neither is an error", () => {
    expect(() => backendOfTarget(path.join(dir, "nothing-here"))).toThrow(
      /not a model: expected a \.gguf file, a directory containing config\.json, or a diffusers directory/,
    );
  });
});

describe("backend field", () => {
  it("every curated entry has a backend that matches its uri", () => {
    for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
      expect(info.backend, name).toBe(backendOfTarget(info.uri));
    }
  });

  it("an object alias without backend is an error naming the file", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({ client: { modelAliases: { coder: { uri: "hf:org/repo:Q4_K_M" } } } }),
    );
    expect(() => _resolveModelName("coder", fileTarget(aliasFile))).toThrow(
      new RegExp(`Invalid config in ${aliasFile}[\\s\\S]*client\\.modelAliases\\.coder`),
    );
  });

  it("an object alias whose backend disagrees with its uri is an error", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: { modelAliases: { coder: { backend: "mlx", uri: "hf:org/repo:Q4_K_M" } } },
      }),
    );
    expect(() => _resolveModelName("coder", fileTarget(aliasFile))).toThrow(
      /says backend "mlx" but its uri "hf:org\/repo:Q4_K_M" is a GGUF file/,
    );
  });

  it("a string alias reads its backend from the prefix", () => {
    fs.writeFileSync(
      aliasFile,
      JSON.stringify({
        client: { modelAliases: { coder: "mlx:mlx-community/Qwen3-Coder-Next-4bit" } },
      }),
    );
    const entry = _listModelNames(fileTarget(aliasFile)).find((e) => e.name === "coder");
    expect(entry?.backend).toBe("mlx");
  });

  it("a catalog entry with a valid backend and a bad uri is skipped, not thrown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseCatalog(
      JSON.stringify({
        version: 1,
        models: { bad: { backend: "llama-cpp", uri: "ftp://nope" } },
      }),
    );
    expect(Object.keys(parsed)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping "bad"'));
    warn.mockRestore();
  });

  it("a remote catalog entry without backend, or with the wrong one, is skipped with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseCatalog(
      JSON.stringify({
        version: 1,
        models: {
          ok: { backend: "llama-cpp", uri: "hf:org/ok:Q4_K_M" },
          missing: { uri: "hf:org/bad:Q4_K_M" },
          wrong: { backend: "mlx", uri: "hf:org/wrong:Q4_K_M" },
        },
      }),
    );
    expect(Object.keys(parsed)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping "missing"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping "wrong"'));
    warn.mockRestore();
  });
});

describe("_catalogKind", () => {
  it("reads the curated entry's kind, by name or by URI", () => {
    expect(_catalogKind("qwen3-embedding-4b-mlx")).toBe("embedding");
    expect(_catalogKind("qwen3-coder-next-mlx")).toBe("chat");
    expect(CURATED_LOCAL_MODELS["qwen3-coder-next-mlx"].tags).toEqual(["coding"]);
    expect(_catalogKind(CURATED_LOCAL_MODELS["qwen3-embedding-4b-mlx"].uri)).toBe("embedding");
  });

  it("reads an alias written before the split, whose category stands for both", () => {
    expect(kindOfCategory("coding")).toBe("chat");
    expect(tagsOfCategory("coding")).toEqual(["coding"]);
    expect(kindOfCategory("general")).toBe("chat");
    expect(tagsOfCategory("general")).toEqual([]);
    expect(kindOfCategory("image")).toBe("image");
    expect(tagsOfCategory("image")).toEqual([]);
    expect(kindOfCategory(undefined)).toBeUndefined();
    expect(tagsOfCategory(undefined)).toBeUndefined();
    const file = path.join(dir, "agency.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        client: {
          modelAliases: {
            old: { backend: "mlx", uri: "mlx:org/old", category: "coding" },
            fresh: { backend: "mlx", uri: "mlx:org/fresh", kind: "chat", tags: ["writing"] },
          },
        },
      }),
    );
    expect(_catalogKind("old", fileTarget(file))).toBe("chat");
    expect(_catalogKind("fresh", fileTarget(file))).toBe("chat");
    const names = _listModelNames(fileTarget(file));
    expect(names.find((n) => n.name === "old")?.tags).toEqual(["coding"]);
    expect(names.find((n) => n.name === "fresh")?.tags).toEqual(["writing"]);
  });

  it("reads an object alias's kind and is undefined for the rest", () => {
    const file = path.join(dir, "agency.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        client: {
          modelAliases: {
            emb: { backend: "mlx", uri: "mlx:org/emb", kind: "embedding" },
            plain: "mlx:org/plain",
          },
        },
      }),
    );
    expect(_catalogKind("emb", fileTarget(file))).toBe("embedding");
    expect(_catalogKind("mlx:org/emb", fileTarget(file))).toBe("embedding");
    expect(_catalogKind("plain", fileTarget(file))).toBeUndefined();
    expect(_catalogKind("mlx:org/anything", fileTarget(file))).toBeUndefined();
  });
});

describe("_resolveModel", () => {
  it("returns backend and target for a curated name", () => {
    expect(_resolveModel("smollm2-135m")).toEqual({
      backend: "llama-cpp",
      target: CURATED_LOCAL_MODELS["smollm2-135m"].uri,
    });
  });

  it("returns mlx for an mlx: URI and for a directory alias", () => {
    const model = path.join(dir, "m");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "");
    fs.writeFileSync(aliasFile, JSON.stringify({ client: { modelAliases: { local: model } } }));
    expect(_resolveModel("mlx:org/repo")).toEqual({ backend: "mlx", target: "mlx:org/repo" });
    expect(_resolveModel("local", fileTarget(aliasFile))).toEqual({
      backend: "mlx",
      target: model,
    });
    expect(_resolveModel(model)).toEqual({ backend: "mlx", target: model });
  });

  it("the unknown-name error mentions mlx: and diffusers: URIs", () => {
    expect(() => _resolveModel("nope")).toThrow(
      /or pass a \.gguf path, an "hf:" URI, an "mlx:" or "diffusers:" URI, or a model directory/,
    );
  });
});

describe("formatLocalList with mlx models", () => {
  const entries: ModelNameEntry[] = [
    {
      name: "coder",
      backend: "mlx",
      target: "mlx:org/coder",
      source: "alias",
      sizeBytes: 44_900_000_000,
    },
    { name: "tiny", backend: "llama-cpp", target: "hf:o/tiny:Q4", source: "curated" },
  ];
  const files = [
    {
      name: "org/coder",
      path: "/d/mlx/org--coder",
      sizeBytes: 44_000_000_000,
      backend: "mlx" as const,
      complete: true,
    },
    {
      name: "org/other",
      path: "/d/mlx/org--other",
      sizeBytes: 1_000_000_000,
      backend: "mlx" as const,
      complete: false,
    },
  ];

  it("shows a BACKEND column and ticks a complete mlx model by repo id", () => {
    const out = formatLocalList({ dir: "/d", entries, manifest: {}, files });
    const lines = out.split("\n");
    expect(lines[2]).toContain("BACKEND");
    const coder = lines.find((l) => l.includes("coder"));
    expect(coder).toContain("✓");
    expect(coder).toContain("mlx");
    expect(coder).toContain("44.00 GB");
    expect(lines.find((l) => l.includes("tiny"))).toContain("llama-cpp");
  });

  it("lists an unclaimed mlx directory under OTHER FILES with its state", () => {
    const out = formatLocalList({ dir: "/d", entries, manifest: {}, files });
    expect(out).toContain("OTHER FILES");
    expect(out).toContain("org/other  (mlx, incomplete)  1.00 GB");
    expect(out).not.toMatch(/OTHER FILES[\s\S]*org\/coder/);
  });

  it("ticks a pinned revision only when it matches the record", () => {
    const pinned: ModelNameEntry[] = [
      { name: "coder", backend: "mlx", target: "mlx:org/coder@7b93", source: "alias" },
    ];
    const withRev = [{ ...files[0], revision: "7b9321eabb85ce79625cac3f61ea691e4ea984b5" }];
    const ok = formatLocalList({ dir: "/d", entries: pinned, manifest: {}, files: withRev });
    expect(ok.split("\n").find((l) => l.includes("coder"))).toContain("✓");
    const other = formatLocalList({
      dir: "/d",
      entries: pinned,
      manifest: {},
      files: [{ ...files[0], revision: "9c1f0a2" }],
    });
    expect(other.split("\n").find((l) => l.includes("coder"))).not.toContain("✓");
  });

  it("does not tick an incomplete mlx model", () => {
    const out = formatLocalList({
      dir: "/d",
      entries,
      manifest: {},
      files: [{ ...files[0], complete: false }],
    });
    expect(out.split("\n").find((l) => l.includes("coder"))).not.toContain("✓");
  });
});

describe("_listDownloadedModels with mlx directories", () => {
  it("lists a recorded mlx directory by repo id with its size and completeness", () => {
    const cache = path.join(dir, "models");
    const model = path.join(cache, "mlx", "org--repo");
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "xxxxxxxx");
    fs.writeFileSync(
      path.join(model, ".agency-model.json"),
      JSON.stringify({
        repo: "org/repo",
        revision: "abc",
        files: {
          "config.json": { size: 2, complete: true },
          "model.safetensors": { size: 8, complete: true },
        },
      }),
    );
    // A directory with no record is not a model.
    fs.mkdirSync(path.join(cache, "mlx", "junk"));
    const listed = _listDownloadedModels(cache);
    expect(listed).toEqual([
      {
        name: "org/repo",
        path: model,
        sizeBytes: expect.any(Number),
        backend: "mlx",
        complete: true,
        revision: "abc",
        layout: "agency",
      },
    ]);
    // A complete model is the size its record declares.
    expect(listed[0].sizeBytes).toBe(10);
  });
});

describe("_removeServedModel", () => {
  it("deletes the model directory under mlx/ and refuses anything else", () => {
    const model = path.join(dir, "mlx", "org--repo");
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    expect(_removeServedModel("mlx", "org/repo", dir)).toBe(true);
    expect(fs.existsSync(model)).toBe(false);
    expect(_removeServedModel("mlx", "org/repo", dir)).toBe(false);
    // The slash becomes "--", so a repo id cannot name a path outside mlx/.
    expect(_removeServedModel("mlx", "../../etc", dir)).toBe(false);
  });
});

describe("_downloadModel for mlx", () => {
  it("passes HF_TOKEN to the snapshot request as well as the download", async () => {
    const hub = await startFakeHub(
      "org/repo",
      [{ path: "config.json", bytes: Buffer.from("{}") }],
      { gated: true },
    );
    process.env.HF_TOKEN = "hf_test";
    try {
      const out = await _downloadModel("mlx:org/repo", dir, {
        hubUrl: hub.baseUrl,
        allowHttp: true,
      });
      expect(fs.readFileSync(path.join(out, "config.json"), "utf-8")).toBe("{}");
      expect(hub.authSeen.api.every((a) => a === "Bearer hf_test")).toBe(true);
    } finally {
      delete process.env.HF_TOKEN;
      await hub.close();
    }
  });

  it("downloads an mlx: URI into <cacheDir>/mlx/<org>--<repo> and lists it", async () => {
    const big = Buffer.alloc(1500, 7);
    const hub = await startFakeHub("org/repo", [
      { path: "config.json", bytes: Buffer.from("{}") },
      { path: "model.safetensors", bytes: big },
    ]);
    const out = await _downloadModel("mlx:org/repo", dir, { hubUrl: hub.baseUrl, allowHttp: true });
    expect(out).toBe(path.join(dir, "mlx", "org--repo"));
    expect(fs.readFileSync(path.join(out, "config.json"), "utf-8")).toBe("{}");
    expect(fs.readFileSync(path.join(out, "model.safetensors")).equals(big)).toBe(true);
    expect(isMlxModelComplete(readMlxModelRecord(out)!)).toBe(true);
    expect(_listDownloadedModels(dir).map((m) => m.name)).toEqual(["org/repo"]);
    await hub.close();
  });

  it("returns a model directory as is", async () => {
    const model = path.join(dir, "m");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "");
    await expect(_downloadModel(model, dir)).resolves.toBe(model);
  });
});

describe("companion downloads", () => {
  const ORPHEUS = "mlx-community/orpheus-3b-0.1-ft-4bit";
  const SNAC = "mlx-community/snac_24khz";
  const FILES = [
    { path: "config.json", bytes: Buffer.from('{"model_type":"llama"}') },
    { path: "model.safetensors", bytes: Buffer.alloc(1500, 7) },
  ];

  it("downloads each companion after the model, by catalog name or by URI", async () => {
    const hub = await startFakeHub([ORPHEUS, SNAC], FILES);
    try {
      const opts = { hubUrl: hub.baseUrl, allowHttp: true, chunkBytes: 1000, retryDelayMs: 1 };
      const out = await _downloadModel("orpheus-3b-mlx", dir, opts);
      expect(out).toBe(path.join(dir, "mlx", "mlx-community--orpheus-3b-0.1-ft-4bit"));
      const snac = path.join(dir, "mlx", "mlx-community--snac_24khz");
      expect(isMlxModelComplete(readMlxModelRecord(snac)!)).toBe(true);

      // Every range was fetched once, so a second run fetches nothing.
      const before = { ...hub.rangeHits };
      await _downloadModel("orpheus-3b-mlx", dir, opts);
      expect(hub.rangeHits).toEqual(before);

      // The URI the catalog entry points at pulls the companion too, or
      // downloading by URI would leave the model unable to start.
      fs.rmSync(snac, { recursive: true });
      await _downloadModel(`mlx:${ORPHEUS}`, dir, opts);
      expect(isMlxModelComplete(readMlxModelRecord(snac)!)).toBe(true);

      // A pinned revision names the same model, so it needs the same
      // companion.
      fs.rmSync(snac, { recursive: true });
      await _downloadModel(`mlx:${ORPHEUS}@7b9321e`, dir, opts);
      expect(isMlxModelComplete(readMlxModelRecord(snac)!)).toBe(true);
    } finally {
      await hub.close();
    }
  });
});

describe("Hugging Face caches", () => {
  /** A cache folder in the Hub's own layout: files under snapshots/<sha>. */
  function hubModel(
    hubDir: string,
    repo: string,
    sha: string,
    opts: { ref?: string } = {},
  ): string {
    const folder = path.join(hubDir, `models--${repo.replace("/", "--")}`);
    const snapshot = path.join(folder, "snapshots", sha);
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, "config.json"), "{}");
    fs.writeFileSync(path.join(snapshot, "model.safetensors"), "xxxxxxxxxx");
    const ref = opts.ref ?? sha;
    if (ref !== "") {
      fs.mkdirSync(path.join(folder, "refs"), { recursive: true });
      fs.writeFileSync(path.join(folder, "refs", "main"), ref);
    }
    return snapshot;
  }

  it("hubSnapshotDir follows refs/main", () => {
    const hub = path.join(dir, "hub1");
    const snapshot = hubModel(hub, "org/repo", "abc123");
    hubModel(hub, "org/repo", "old999", { ref: "" });
    const folder = path.join(hub, "models--org--repo");
    fs.writeFileSync(path.join(folder, "refs", "main"), "abc123");
    expect(hubSnapshotDir(folder)).toBe(snapshot);
  });

  it("hubSnapshotDir takes a lone snapshot when there is no ref", () => {
    const hub = path.join(dir, "hub2");
    const snapshot = hubModel(hub, "org/repo", "abc123", { ref: "" });
    expect(hubSnapshotDir(path.join(hub, "models--org--repo"))).toBe(snapshot);
  });

  it("hubSnapshotDir refuses to guess between two snapshots", () => {
    const hub = path.join(dir, "hub3");
    hubModel(hub, "org/repo", "aaa", { ref: "" });
    hubModel(hub, "org/repo", "bbb", { ref: "" });
    expect(() => hubSnapshotDir(path.join(hub, "models--org--repo"))).toThrow(
      /holds 2 snapshots and no refs\/main/,
    );
  });

  it("hubSnapshotDir refuses a refs/main whose snapshot is not there", () => {
    const hub = path.join(dir, "hub-badref");
    hubModel(hub, "org/repo", "aaa", { ref: "" });
    const folder = path.join(hub, "models--org--repo");
    fs.mkdirSync(path.join(folder, "refs"), { recursive: true });
    fs.writeFileSync(path.join(folder, "refs", "main"), "bbb");
    // Serving "aaa" here would be a revision the user did not ask for.
    expect(() => hubSnapshotDir(folder)).toThrow(/is on revision bbb/);
  });

  it("hubSnapshotDir is null for a directory that is not a cache", () => {
    expect(hubSnapshotDir(dir)).toBe(null);
  });

  it("hubRepoOfDirName reads the repo id, keeping a -- inside the repo name", () => {
    expect(hubRepoOfDirName("models--mlx-community--Qwen3.8-27B-4bit")).toBe(
      "mlx-community/Qwen3.8-27B-4bit",
    );
    expect(hubRepoOfDirName("models--org--we--ird")).toBe("org/we--ird");
    expect(hubRepoOfDirName("mlx")).toBe(null);
    expect(hubRepoOfDirName("models--org")).toBe(null);
  });

  it("_listDownloadedModels reads a cache in the models directory, and under hub/", () => {
    const cache = path.join(dir, "models-hub");
    const one = hubModel(cache, "org/one", "abc123");
    const two = hubModel(path.join(cache, "hub"), "org/two", "def456");
    const listed = _listDownloadedModels(cache).filter((m) => m.layout === "hub");
    expect(listed.map((m) => [m.name, m.path, m.revision, m.complete])).toEqual([
      ["org/one", one, "abc123", true],
      ["org/two", two, "def456", true],
    ]);
    expect(listed[0].sizeBytes).toBeGreaterThan(10);
  });

  it("_findDownloadedServedModel finds a repo id in a Hugging Face cache", () => {
    const cache = path.join(dir, "models-find");
    const snapshot = hubModel(cache, "org/repo", "abc123");
    expect(_findDownloadedServedModel("mlx", "org/repo", cache)?.path).toBe(snapshot);
    expect(_findDownloadedServedModel("mlx", "org/missing", cache)).toBe(null);
  });

  it("_findDownloadedServedModel finds a pinned revision that is not the current one", () => {
    const cache = path.join(dir, "models-pin");
    hubModel(cache, "org/repo", "aaa111");
    // A second revision in the same cache. refs/main still names the first.
    const older = path.join(cache, "models--org--repo", "snapshots", "bbb222");
    fs.mkdirSync(older, { recursive: true });
    fs.writeFileSync(path.join(older, "config.json"), "{}");
    fs.writeFileSync(path.join(older, "model.safetensors"), "xxxxxxxxxx");
    expect(_findDownloadedServedModel("mlx", "org/repo", cache)?.revision).toBe("aaa111");
    expect(_findDownloadedServedModel("mlx", "org/repo", cache, "bbb")?.path).toBe(older);
    expect(_findDownloadedServedModel("mlx", "org/repo", cache, "ccc")).toBe(null);
  });

  it("refuses a refs/main that is a symlink instead of reading what it points at", () => {
    const cache = path.join(dir, "models-link");
    hubModel(cache, "org/repo", "aaa111", { ref: "" });
    const folder = path.join(cache, "models--org--repo");
    const secret = path.join(dir, "secret.txt");
    fs.writeFileSync(secret, "not a revision");
    fs.mkdirSync(path.join(folder, "refs"), { recursive: true });
    fs.symlinkSync(secret, path.join(folder, "refs", "main"));
    expect(() => hubSnapshotDir(folder)).toThrow(/is not a file Agency will read/);
  });

  it("_resolveModel takes a cache folder and resolves it to its snapshot", () => {
    const hub = path.join(dir, "hub-resolve");
    const snapshot = hubModel(hub, "org/repo", "abc123");
    const folder = path.join(hub, "models--org--repo");
    expect(_resolveModel(folder)).toEqual({ backend: "mlx", target: snapshot });
    // The snapshot path itself still works.
    expect(_resolveModel(snapshot)).toEqual({ backend: "mlx", target: snapshot });
  });

  it("_resolveModel takes a bare repo id when that model is on disk", () => {
    const cache = path.join(dir, "models-bare");
    hubModel(cache, "org/repo", "abc123");
    process.env.AGENCY_MODELS_DIR = cache;
    try {
      expect(_resolveModel("org/repo")).toEqual({ backend: "mlx", target: "mlx:org/repo" });
      expect(() => _resolveModel("org/absent")).toThrow(/Unknown local model/);
    } finally {
      delete process.env.AGENCY_MODELS_DIR;
    }
  });
});

describe("the diffusers backend", () => {
  it("downloads only the files the pipeline reads, into diffusers/", async () => {
    const index = JSON.stringify({
      _class_name: "ZImagePipeline",
      transformer: ["diffusers", "ZImageTransformer2DModel"],
      tokenizer: ["transformers", "Qwen2Tokenizer"],
    });
    const weights = Buffer.alloc(3000, 7);
    const hub = await startFakeHub("org/image", [
      { path: "model_index.json", bytes: Buffer.from(index) },
      { path: "single-file-copy.safetensors", bytes: Buffer.alloc(5000, 1) },
      { path: "assets/banner.png", bytes: Buffer.from("png") },
      { path: "transformer/config.json", bytes: Buffer.from("{}") },
      { path: "transformer/model.safetensors", bytes: weights },
      { path: "transformer/model.bin", bytes: Buffer.alloc(3000, 2) },
      { path: "tokenizer/vocab.json", bytes: Buffer.from("{}") },
    ]);
    try {
      const out = await _downloadModel("diffusers:org/image", dir, {
        hubUrl: hub.baseUrl,
        allowHttp: true,
      });
      expect(out).toBe(path.join(dir, "diffusers", "org--image"));
      const record = readMlxModelRecord(out)!;
      expect(Object.keys(record.files).sort()).toEqual([
        "model_index.json",
        "tokenizer/vocab.json",
        "transformer/config.json",
        "transformer/model.safetensors",
      ]);
      expect(isMlxModelComplete(record)).toBe(true);
      expect(
        fs.readFileSync(path.join(out, "transformer", "model.safetensors")).equals(weights),
      ).toBe(true);
      expect(fs.existsSync(path.join(out, "single-file-copy.safetensors"))).toBe(false);
      expect(_listDownloadedModels(dir).map((m) => [m.name, m.backend, m.complete])).toEqual([
        ["org/image", "diffusers", true],
      ]);
    } finally {
      await hub.close();
    }
  });

  it("refuses a diffusers: repo with no model_index.json, writing nothing", async () => {
    const hub = await startFakeHub("org/notimage", [
      { path: "config.json", bytes: Buffer.from("{}") },
      { path: "model.safetensors", bytes: Buffer.alloc(10) },
    ]);
    try {
      await expect(
        _downloadModel("diffusers:org/notimage", dir, { hubUrl: hub.baseUrl, allowHttp: true }),
      ).rejects.toThrow("org/notimage has no model_index.json, so it is not a diffusers model.");
      expect(fs.existsSync(path.join(dir, "diffusers"))).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it("an mlx: download of a repo with model_index.json is not filtered", async () => {
    const hub = await startFakeHub("org/both", [
      { path: "config.json", bytes: Buffer.from("{}") },
      { path: "model_index.json", bytes: Buffer.from("{}") },
      { path: "model.safetensors", bytes: Buffer.alloc(10) },
      { path: "extra/readme.txt", bytes: Buffer.from("x") },
    ]);
    try {
      const out = await _downloadModel("mlx:org/both", dir, {
        hubUrl: hub.baseUrl,
        allowHttp: true,
      });
      expect(Object.keys(readMlxModelRecord(out)!.files).sort()).toEqual([
        "config.json",
        "extra/readme.txt",
        "model.safetensors",
        "model_index.json",
      ]);
    } finally {
      await hub.close();
    }
  });

  /** A diffusers model: model_index.json at the top, weights one level
   *  down. */
  function diffusersModel(at: string): string {
    fs.mkdirSync(path.join(at, "transformer"), { recursive: true });
    fs.mkdirSync(path.join(at, "vae"), { recursive: true });
    fs.writeFileSync(path.join(at, "model_index.json"), '{"_class_name": "ZImagePipeline"}');
    fs.writeFileSync(path.join(at, "transformer", "config.json"), "{}");
    fs.writeFileSync(path.join(at, "transformer", "model.safetensors"), Buffer.alloc(1000));
    fs.writeFileSync(path.join(at, "vae", "model.safetensors"), Buffer.alloc(500));
    return at;
  }

  it("parses diffusers: URIs with the same rules as mlx: URIs", () => {
    expect(parseServedUri("diffusers:Tongyi-MAI/Z-Image-Turbo")).toEqual({
      backend: "diffusers",
      repo: "Tongyi-MAI/Z-Image-Turbo",
      revision: undefined,
    });
    expect(parseServedUri("diffusers:org/repo@abc123")).toEqual({
      backend: "diffusers",
      repo: "org/repo",
      revision: "abc123",
    });
    for (const bad of [
      "diffusers:../x",
      "diffusers:org",
      "diffusers:org/..",
      "diffuser:org/repo",
    ]) {
      expect(isServedUri(bad)).toBe(false);
    }
    // A diffusers: URI is not an mlx: URI.
    expect(isMlxUri("diffusers:org/repo")).toBe(false);
    expect(() => parseMlxUri("diffusers:org/repo")).toThrow(/is not an mlx: URI/);
    expect(backendOfTarget("diffusers:org/repo")).toBe("diffusers");
    expect(backendOfTarget("diffusers:org/repo@abc123")).toBe("diffusers");
  });

  it("a directory with model_index.json and weights one level down is a diffusers model", () => {
    const model = diffusersModel(path.join(dir, "z"));
    expect(isDiffusersDir(model)).toBe(true);
    expect(isModelDir(model)).toBe(false);
    expect(backendOfTarget(model)).toBe("diffusers");
    expect(_modelFilesOnDisk({ backend: "diffusers", target: model }, dir)?.sizeBytes).toBe(
      fs.statSync(path.join(model, "model_index.json")).size + 2 + 1000 + 500,
    );
  });

  it("model_index.json without weights is neither backend", () => {
    const model = path.join(dir, "empty");
    fs.mkdirSync(path.join(model, "transformer"), { recursive: true });
    fs.writeFileSync(path.join(model, "model_index.json"), "{}");
    fs.writeFileSync(path.join(model, "transformer", "model.bin"), "");
    expect(isDiffusersDir(model)).toBe(false);
    expect(() => backendOfTarget(model)).toThrow(/is not a model/);
  });

  it("an MLX model directory is still mlx", () => {
    const model = path.join(dir, "m");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "config.json"), "{}");
    fs.writeFileSync(path.join(model, "model.safetensors"), "");
    expect(isDiffusersDir(model)).toBe(false);
    expect(backendOfTarget(model)).toBe("mlx");
  });

  it("a Hugging Face snapshot of symlinks in the diffusers shape is a diffusers model", () => {
    const blobs = path.join(dir, "blobs");
    const snapshot = path.join(dir, "snapshots", "abc");
    fs.mkdirSync(blobs);
    fs.mkdirSync(path.join(snapshot, "transformer"), { recursive: true });
    fs.writeFileSync(path.join(blobs, "i0"), "{}");
    fs.writeFileSync(path.join(blobs, "w0"), Buffer.alloc(1000));
    fs.symlinkSync("../../blobs/i0", path.join(snapshot, "model_index.json"));
    fs.symlinkSync("../../../blobs/w0", path.join(snapshot, "transformer", "model.safetensors"));
    expect(isDiffusersDir(snapshot)).toBe(true);
    expect(backendOfTarget(snapshot)).toBe("diffusers");
  });

  it("lists a diffusers model from each layout with backend diffusers", () => {
    const cache = path.join(dir, "models");
    // A Hugging Face cache.
    const snapshot = diffusersModel(
      path.join(cache, "hub", "models--org--hubmodel", "snapshots", "abc123"),
    );
    fs.mkdirSync(path.join(cache, "hub", "models--org--hubmodel", "refs"));
    fs.writeFileSync(path.join(cache, "hub", "models--org--hubmodel", "refs", "main"), "abc123");
    // Agency's own layout: a folder under diffusers/ with a record.
    const own = diffusersModel(path.join(cache, "diffusers", "org--own"));
    fs.writeFileSync(
      path.join(own, ".agency-model.json"),
      JSON.stringify({
        repo: "org/own",
        revision: "def456",
        files: { "model_index.json": { size: 2, complete: true } },
      }),
    );
    const listed = _listDownloadedModels(cache).map((m) => [m.name, m.backend, m.layout, m.path]);
    expect(listed).toEqual([
      ["org/own", "diffusers", "agency", own],
      ["org/hubmodel", "diffusers", "hub", snapshot],
    ]);
    expect(_findDownloadedServedModel("diffusers", "org/hubmodel", cache)?.path).toBe(snapshot);
    expect(_findDownloadedServedModel("mlx", "org/hubmodel", cache)).toBe(null);
    expect(_findDownloadedServedModel("diffusers", "org/hubmodel", cache, "abc")?.path).toBe(
      snapshot,
    );
  });

  it("removes a diffusers model from its own folder only", () => {
    const cache = path.join(dir, "models");
    diffusersModel(path.join(cache, "diffusers", "org--repo"));
    expect(_removeServedModel("mlx", "org/repo", cache)).toBe(false);
    expect(_removeServedModel("diffusers", "org/repo", cache)).toBe(true);
    expect(fs.existsSync(path.join(cache, "diffusers", "org--repo"))).toBe(false);
  });
});
