import { describe, it, expect } from "vitest";
import { AgencyConfigSchema } from "./config.js";

describe("AgencyConfigSchema", () => {
  it("should accept an empty config", () => {
    const result = AgencyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should accept a config with existing fields", () => {
    const result = AgencyConfigSchema.safeParse({
      verbose: true,
      outDir: "dist",
      maxToolCallRounds: 5,
    });
    expect(result.success).toBe(true);
  });

  describe("memory block", () => {
    it("accepts a minimal memory block (only `dir`)", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: { dir: ".agency/memory" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts a fully populated memory block", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: {
          dir: ".agency/memory",
          model: "gpt-4o-mini",
          autoExtract: { interval: 5 },
          compaction: { trigger: "token", threshold: 50000 },
          embeddings: { model: "text-embedding-3-small" },
        },
      });
      expect(result.success).toBe(true);
    });

    it("rejects a memory block missing the required `dir`", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: { model: "gpt-4o-mini" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects an invalid compaction.trigger value", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: {
          dir: ".agency/memory",
          compaction: { trigger: "bogus" },
        },
      });
      expect(result.success).toBe(false);
    });

    it("rejects a non-numeric autoExtract.interval", () => {
      const result = AgencyConfigSchema.safeParse({
        memory: {
          dir: ".agency/memory",
          autoExtract: { interval: "five" },
        },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("AgencyConfig typechecker key", () => {
  it("accepts the new typechecker object", () => {
    const result = AgencyConfigSchema.safeParse({
      typechecker: {
        enabled: true,
        strict: true,
        strictTypes: true,
        undefinedFunctions: "warn",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid undefinedFunctions value", () => {
    const result = AgencyConfigSchema.safeParse({
      typechecker: { undefinedFunctions: "banana" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty typechecker object", () => {
    const result = AgencyConfigSchema.safeParse({ typechecker: {} });
    expect(result.success).toBe(true);
  });
});
