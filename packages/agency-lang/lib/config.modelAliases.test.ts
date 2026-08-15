import { describe, it, expect } from "vitest";
import { AgencyConfigSchema } from "./config.js";

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
      uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
      source: "remote",
      params: "2B",
      sizeBytes: 1_280_000_000,
      category: "general",
      contextWindow: 131072,
      license: "apache-2.0",
      description: "Most popular modern small general model.",
      sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    };
    const parsed = AgencyConfigSchema.parse({ client: { modelAliases: { "qwen3.5-2b": entry } } });
    expect(parsed.client?.modelAliases).toEqual({ "qwen3.5-2b": entry });
  });
  it("accepts string and object aliases side by side", () => {
    const parsed = AgencyConfigSchema.parse({
      client: { modelAliases: { my7b: "hf:org/repo:Q4_K_M", managed: { uri: "hf:o/m:Q4" } } },
    });
    expect(parsed.client?.modelAliases).toEqual({
      my7b: "hf:org/repo:Q4_K_M",
      managed: { uri: "hf:o/m:Q4" },
    });
  });
  it("rejects a value that is neither a string nor an object", () => {
    expect(() => AgencyConfigSchema.parse({ client: { modelAliases: { x: 5 } } })).toThrow();
  });
  it("rejects an object alias with no uri", () => {
    expect(() =>
      AgencyConfigSchema.parse({ client: { modelAliases: { x: { params: "2B" } } } }),
    ).toThrow();
  });
});
