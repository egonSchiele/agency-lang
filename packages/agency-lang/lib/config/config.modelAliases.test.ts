import { describe, it, expect } from "vitest";
import { AgencyConfigSchema, validateConfig } from "./config.js";

describe("config client.modelAliases", () => {
  it("accepts a record of name -> uri", () => {
    const parsed = AgencyConfigSchema.parse({
      client: { modelAliases: { my7b: "hf:org/repo:Q4_K_M" } },
    });
    expect(parsed.client?.modelAliases).toEqual({ my7b: "hf:org/repo:Q4_K_M" });
  });
  it("accepts the rich object form written by `agency local refresh`", () => {
    // Every field `_refreshCatalog` writes, so the schema can't drift from
    // what the refresh actually puts on disk (this is what broke: refresh
    // wrote objects that the config loader then rejected on the next run).
    const entry = {
      backend: "llama-cpp",
      uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
      source: "remote",
      params: "2B",
      sizeBytes: 1_280_000_000,
      kind: "chat",
      tags: ["reasoning"],
      contextWindow: 131072,
      license: "apache-2.0",
      description: "Most popular modern small general model.",
      sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
      companions: ["mlx:org/decoder"],
    };
    const parsed = AgencyConfigSchema.parse({ client: { modelAliases: { "qwen3.5-2b": entry } } });
    expect(parsed.client?.modelAliases).toEqual({ "qwen3.5-2b": entry });
  });
  it("accepts an alias written by an older refresh, which says category", () => {
    const entry = {
      backend: "llama-cpp",
      uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
      source: "remote",
      category: "general",
    };
    const parsed = AgencyConfigSchema.parse({ client: { modelAliases: { old: entry } } });
    expect(parsed.client?.modelAliases).toEqual({ old: entry });
  });
  it("rejects a kind that is not a kind of model, naming the field", () => {
    const { error } = validateConfig(
      { client: { modelAliases: { e: { backend: "mlx", uri: "mlx:org/e", kind: "embeddings" } } } },
      "agency.json",
    );
    expect(error).toMatch(/client\.modelAliases\.e\.kind: /);
  });
  it("rejects tags that are not a list of strings, naming the field", () => {
    const { error } = validateConfig(
      { client: { modelAliases: { c: { backend: "mlx", uri: "mlx:org/c", tags: "coding" } } } },
      "agency.json",
    );
    expect(error).toMatch(/client\.modelAliases\.c\.tags: /);
  });
  it("accepts string and object aliases side by side", () => {
    const parsed = AgencyConfigSchema.parse({
      client: {
        modelAliases: {
          my7b: "hf:org/repo:Q4_K_M",
          managed: { backend: "llama-cpp", uri: "hf:o/m:Q4" },
        },
      },
    });
    expect(parsed.client?.modelAliases).toEqual({
      my7b: "hf:org/repo:Q4_K_M",
      managed: { backend: "llama-cpp", uri: "hf:o/m:Q4" },
    });
  });
  it("rejects a value that is neither a string nor an object", () => {
    expect(() => AgencyConfigSchema.parse({ client: { modelAliases: { x: 5 } } })).toThrow();
    // No branch of the union fits, so the error names the alias itself.
    const { error } = validateConfig({ client: { modelAliases: { x: 5 } } }, "agency.json");
    expect(error).toMatch(/client\.modelAliases\.x: /);
  });
  it("rejects an object alias with no uri", () => {
    expect(() =>
      AgencyConfigSchema.parse({ client: { modelAliases: { x: { params: "2B" } } } }),
    ).toThrow();
  });
  it("an object alias needs a backend", () => {
    const result = AgencyConfigSchema.safeParse({
      client: { modelAliases: { x: { uri: "hf:org/repo:Q4_K_M" } } },
    });
    expect(result.success).toBe(false);
  });
});
