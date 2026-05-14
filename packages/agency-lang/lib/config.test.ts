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
