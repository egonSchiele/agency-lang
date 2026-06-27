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
